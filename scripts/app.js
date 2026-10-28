import {
  connectPrinterFromButton,
  loadAuthorizedPrinter,
  printLabel,
} from "./printer.js?v=text-size-1";

const printButton = document.getElementById("print-button");
const status = document.getElementById("status");
const shelfHint = document.getElementById("shelf-hint");
const summary = document.getElementById("summary");
const selections = { row: null, opening: null, shelf: null, boxes: null };
let printing = false;

const setStatus = (message) => {
  status.textContent = message;
};

function selectedValue(group, button) {
  if (group === "boxes" && button.dataset.value === "none") return null;
  return Number(button.dataset.value);
}

function labelsToPrint() {
  const { row, opening, shelf, boxes } = selections;

  if (boxes === null) {
    return Array.from({ length: shelf }, (_, index) => {
      const shelfNumber = index + 1;
      return {
        code: `${row},${opening},${shelfNumber}`,
        lines: [`Desc. ${opening}`, `Polita ${shelfNumber}`],
      };
    });
  }

  return Array.from({ length: boxes }, (_, index) => {
    const boxNumber = index + 1;
    return {
      code: `${row},${opening},${shelf},${boxNumber}`,
      lines: [`Cutia ${boxNumber}`],
    };
  });
}

function renderSelections() {
  document.querySelectorAll(".choices").forEach((groupElement) => {
    const group = groupElement.dataset.group;
    groupElement.querySelectorAll("button").forEach((button) => {
      const value = selectedValue(group, button);
      button.setAttribute("aria-pressed", String(selections[group] === value));
    });
  });

  shelfHint.textContent = selections.boxes === null
    ? "Alege numărul de polițe; se imprimă o etichetă pentru fiecare."
    : "Alege polița; se imprimă o etichetă pentru fiecare cutie.";

  if (selections.row === null || selections.opening === null || selections.shelf === null) {
    summary.textContent = "Alege rândul, deschiderea și numărul de polițe.";
  } else if (selections.boxes === null) {
    summary.textContent = selections.shelf === 1
      ? "Se va imprima 1 etichetă pentru poliță."
      : `Se vor imprima ${selections.shelf} etichete pentru polițe.`;
  } else {
    summary.textContent = selections.boxes === 1
      ? `Se va imprima 1 etichetă pentru cutie pe polița ${selections.shelf}.`
      : `Se vor imprima ${selections.boxes} etichete pentru cutii pe polița ${selections.shelf}.`;
  }

  printButton.disabled = printing || selections.row === null || selections.opening === null || selections.shelf === null;
}

document.querySelectorAll(".choices").forEach((groupElement) => {
  const group = groupElement.dataset.group;
  groupElement.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-value]");
    if (!button) return;
    selections[group] = selectedValue(group, button);
    renderSelections();
  });
});

printButton.addEventListener("click", async () => {
  if (printing || printButton.disabled) return;
  if (!isSecureContext) {
    setStatus("Deschide pagina prin HTTPS pentru a imprima.");
    return;
  }
  if (!navigator.bluetooth) {
    setStatus("Deschide pagina în Chrome pe un dispozitiv cu Bluetooth.");
    return;
  }

  const labels = labelsToPrint();
  printing = true;
  renderSelections();
  let sent = 0;

  try {
    await connectPrinterFromButton(setStatus);
    for (let index = 0; index < labels.length; index++) {
      const label = labels[index];
      setStatus(`Se imprimă eticheta ${index + 1} din ${labels.length}...`);
      await printLabel(label.code, label.lines, setStatus);
      sent++;
      if (index + 1 < labels.length) {
        await new Promise((resolve) => setTimeout(resolve, 4000));
      }
    }
    setStatus(labels.length === 1
      ? "Eticheta a fost trimisă imprimantei."
      : `Au fost trimise imprimantei ${labels.length} etichete.`);
  } catch (error) {
    const reason = error.message || "Imprimarea s-a oprit.";
    setStatus(sent ? `${sent} din ${labels.length} etichete au fost trimise. ${reason}` : reason);
  } finally {
    printing = false;
    renderSelections();
  }
});

renderSelections();
printButton.disabled = true;
await loadAuthorizedPrinter();
renderSelections();
