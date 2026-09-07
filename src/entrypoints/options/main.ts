/** Day 1 stub. Session summary and the telemetry consent flow land on Day 3 (T30–T32). */

const sitesEl = document.getElementById("sites") as HTMLUListElement;
const clearBtn = document.getElementById("clear") as HTMLButtonElement;
const clearedEl = document.getElementById("cleared") as HTMLParagraphElement;

async function renderSites(): Promise<void> {
  const { origins = [] } = await chrome.permissions.getAll();
  sitesEl.innerHTML = "";
  if (origins.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "None yet. Enable a site from the toolbar icon while you are on it.";
    sitesEl.append(li);
    return;
  }
  for (const pattern of origins) {
    const li = document.createElement("li");
    li.textContent = pattern.replace(/\/\*$/, "");
    sitesEl.append(li);
  }
}

clearBtn.addEventListener("click", async () => {
  await chrome.storage.local.clear();
  await chrome.storage.session.clear();
  clearedEl.hidden = false;
});

void renderSites();
