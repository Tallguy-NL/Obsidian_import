const vaultCardsEl = document.getElementById('vaultCards');
const pauseResumeBtn = document.getElementById('pauseResumeBtn');
const pulseDotEl = document.getElementById('pulseDot');
const statusLabelEl = document.getElementById('statusLabel');

let paused = false;

function renderVaultCards(vaults) {
  if (!vaults.length) {
    vaultCardsEl.innerHTML = '<div class="empty-state">No vaults configured yet. Add one in Settings to see it here.</div>';
    return;
  }
  vaultCardsEl.innerHTML = vaults
    .map((v) => {
      const hasFailed = v.failed > 0;
      const failedTile = hasFailed
        ? `<div class="stat-tile tile-failed"><span class="value">${v.failed}</span><span class="label">Failed</span></div>`
        : '';
      return `
      <div class="card">
        <h3>${escapeHtml(v.name)}</h3>
        <div class="stat-tiles${hasFailed ? ' has-failed' : ''}">
          <div class="stat-tile"><span class="value">${v.total}</span><span class="label">Total</span></div>
          <div class="stat-tile"><span class="value">${v.processed}</span><span class="label">Processed</span></div>
          <div class="stat-tile"><span class="value">${v.addedThisWeek}</span><span class="label">This week</span></div>
          ${failedTile}
        </div>
      </div>`;
    })
    .join('');
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderPauseButton() {
  pauseResumeBtn.textContent = paused ? 'Resume' : 'Pause';
  pauseResumeBtn.className = paused ? 'btn btn-primary' : 'btn btn-outline';
  pulseDotEl.className = paused ? 'pulse-dot is-paused' : 'pulse-dot is-live';
  statusLabelEl.textContent = paused ? 'Background import paused' : 'Background import running';
}

async function refreshStats() {
  const stats = await window.api.getStats();
  paused = stats.paused;
  renderVaultCards(stats.vaults);
  renderPauseButton();
}

pauseResumeBtn.addEventListener('click', async () => {
  pauseResumeBtn.disabled = true;
  await window.api.setPaused(!paused);
  await refreshStats();
  pauseResumeBtn.disabled = false;
});

window.api.onWorkerEvent((payload) => {
  if (payload?.type === 'documentProcessed' || payload?.type === 'statsChanged') {
    refreshStats();
  }
});

refreshStats();
setInterval(refreshStats, 30_000);
