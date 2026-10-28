const PRINTER_FILTERS = [{ namePrefix: "D" }];
const OPTIONAL_SERVICES = [
  "e7810a71-73ae-499d-8c15-faa9aef0c3f2",
  "49535343-fe7d-4ae5-8fa9-9fafd205e455",
];

let characteristic = null;
let printerDevice = null;
let authorizedPrinter = null;
let connectionPromise = null;
const watchedDevices = new WeakSet();

export function isPrinterConnected() {
  return Boolean(characteristic && printerDevice?.gatt?.connected);
}

function createNiimbotPacket(type, data = []) {
  const bytes = Array.isArray(data) ? data : [data];
  const checksum = bytes.reduce((sum, byte) => sum ^ byte, type ^ bytes.length) & 0xff;
  return new Uint8Array([0x55, 0x55, type, bytes.length, ...bytes, checksum, 0xaa, 0xaa]);
}

async function connectToDevice(device, setStatus) {
  if (isPrinterConnected()) return true;
  if (connectionPromise) return connectionPromise;

  connectionPromise = (async () => {
    setStatus(`Conectare la ${device.name || "imprimantă"}...`);
    const server = device.gatt.connected ? device.gatt : await device.gatt.connect();
    const services = await server.getPrimaryServices();
    let foundCharacteristic = null;

    for (const service of services) {
      const characteristics = await service.getCharacteristics();
      foundCharacteristic = characteristics.find(
        (item) => item.properties.writeWithoutResponse && item.properties.notify,
      );
      if (foundCharacteristic) break;
    }

    if (!foundCharacteristic) throw new Error("Nu a fost găsită conexiunea pentru imprimanta Niimbot.");

    await foundCharacteristic.startNotifications();
    characteristic = foundCharacteristic;
    printerDevice = device;
    authorizedPrinter = device;

    if (!watchedDevices.has(device)) {
      device.addEventListener("gattserverdisconnected", () => {
        characteristic = null;
        printerDevice = null;
        setStatus("Imprimanta s-a deconectat. Apasă PASTE pentru reconectare.");
      });
      watchedDevices.add(device);
    }

    setStatus("Imprimanta este pregătită.");
    return true;
  })();

  try {
    return await connectionPromise;
  } finally {
    connectionPromise = null;
  }
}

export async function loadAuthorizedPrinter() {
  if (!navigator.bluetooth?.getDevices) return false;

  try {
    const devices = await navigator.bluetooth.getDevices();
    authorizedPrinter = devices.find((device) => device.name?.startsWith("D")) || null;
    return Boolean(authorizedPrinter);
  } catch {
    authorizedPrinter = null;
    return false;
  }
}

export function connectPrinterFromButton(setStatus) {
  if (!navigator.bluetooth) {
    return Promise.reject(new Error("Deschide pagina în Chrome pe un dispozitiv cu Bluetooth."));
  }
  if (isPrinterConnected()) return Promise.resolve(true);
  if (connectionPromise) return connectionPromise;

  if (authorizedPrinter) {
    return connectToDevice(authorizedPrinter, setStatus).catch((error) => {
      authorizedPrinter = null;
      characteristic = null;
      printerDevice = null;
      const detail = error?.message ? ` (${error.message})` : "";
      throw new Error(`Reconectarea a eșuat${detail}. Apasă butonul din nou pentru a alege imprimanta.`);
    });
  }

  // requestDevice must start directly from the user's print-button action.
  return navigator.bluetooth
    .requestDevice({ filters: PRINTER_FILTERS, optionalServices: OPTIONAL_SERVICES })
    .then(async (device) => {
      authorizedPrinter = device;
      try {
        return await connectToDevice(device, setStatus);
      } catch (error) {
        authorizedPrinter = null;
        characteristic = null;
        printerDevice = null;
        throw error;
      }
    });
}

async function generateLabelPackets(code, labelLines) {
  const labelWidth = 240;
  const labelHeight = 120;
  const canvas = document.createElement("canvas");
  canvas.width = labelHeight;
  canvas.height = labelWidth;
  const context = canvas.getContext("2d");

  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate((90 * Math.PI) / 180);

  const qr = qrcode(0, "M");
  qr.addData(code);
  qr.make();
  const qrImage = new Image();
  const imageReady = new Promise((resolve, reject) => {
    qrImage.onload = resolve;
    qrImage.onerror = () => reject(new Error("Nu s-a putut genera codul QR."));
  });
  qrImage.src = qr.createDataURL(6, 2);
  await imageReady;

  const qrSize = 85;
  const verticalOffset = 10;
  context.drawImage(qrImage, -labelWidth / 2 + 15, -labelHeight / 2 + 18 + verticalOffset, qrSize, qrSize);
  context.fillStyle = "black";
  context.font = "bold 30px Arial";
  context.textAlign = "left";
  context.textBaseline = "middle";
  const textX = -labelWidth / 2 + qrSize + 35;
  const maxTextWidth = labelWidth / 2 - textX - 5;
  if (labelLines.length > 1) {
    context.fillText(labelLines[0], textX, -18 + verticalOffset, maxTextWidth);
    context.fillText(labelLines[1], textX, 18 + verticalOffset, maxTextWidth);
  } else {
    context.fillText(labelLines[0], textX, verticalOffset, maxTextWidth);
  }
  context.restore();

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const imagePackets = [];
  const widthInBytes = Math.ceil(canvas.width / 8);

  for (let y = 0; y < canvas.height; y++) {
    const lineBytes = new Uint8Array(widthInBytes);
    for (let x = 0; x < canvas.width; x++) {
      const pixelIndex = (y * canvas.width + x) * 4;
      if (imageData.data[pixelIndex] < 128) {
        lineBytes[Math.floor(x / 8)] |= 1 << (7 - (x % 8));
      }
    }
    const header = [(y >> 8) & 0xff, y & 0xff, 0, 0, 0, 1];
    imagePackets.push(createNiimbotPacket(0x85, [...header, ...lineBytes]));
  }

  return imagePackets;
}

export async function printLabel(code, labelLines, setStatus) {
  if (!isPrinterConnected()) throw new Error("Imprimanta nu este conectată.");

  const imagePackets = await generateLabelPackets(code, labelLines);
  const writeAndDelay = async (packet, delay = 5) => {
    await characteristic.writeValueWithoutResponse(packet);
    await new Promise((resolve) => setTimeout(resolve, delay));
  };

  setStatus("Se trimite eticheta...");
  await writeAndDelay(createNiimbotPacket(0x21, [3]));
  await writeAndDelay(createNiimbotPacket(0x23, [1]));
  await writeAndDelay(createNiimbotPacket(0x01, [1]));
  await writeAndDelay(createNiimbotPacket(0x03, [1]));
  await writeAndDelay(createNiimbotPacket(0x13, [0, 240, 0, 120]));
  await writeAndDelay(createNiimbotPacket(0x15, [0, 1]));

  for (const packet of imagePackets) await writeAndDelay(packet, 20);

  await writeAndDelay(createNiimbotPacket(0xe3, [1]));
  await writeAndDelay(createNiimbotPacket(0xf3, [1]));
}
