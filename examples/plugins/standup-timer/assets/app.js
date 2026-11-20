(() => {
  const total = 5 * 60;
  let left = total;
  let timer = null;
  const output = document.getElementById('timer');
  const toggle = document.getElementById('toggle');
  const reset = document.getElementById('reset');
  const status = document.getElementById('status');

  const render = () => {
    const m = String(Math.floor(left / 60)).padStart(2, '0');
    const s = String(left % 60).padStart(2, '0');
    output.textContent = `${m}:${s}`;
  };
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
  const send = (message) => {
    try { parent.postMessage({ type: 'sova.log', message }, '*'); } catch { /* noop */ }
  };
  const tick = () => {
    if (left <= 0) { stop(); toggle.textContent = 'Старт'; status.textContent = 'Время вышло'; send('standup timer finished'); return; }
    left -= 1; render();
  };
  toggle.addEventListener('click', () => {
    if (timer) { stop(); toggle.textContent = 'Продолжить'; status.textContent = 'Пауза'; return; }
    stop(); timer = setInterval(tick, 1000); toggle.textContent = 'Пауза'; status.textContent = 'Идёт стендап';
  });
  reset.addEventListener('click', () => { stop(); left = total; render(); toggle.textContent = 'Старт'; status.textContent = 'Готов к запуску'; });
  render();
  try { parent.postMessage({ type: 'sova.ready', pluginId: 'standup-timer' }, '*'); } catch { /* noop */ }
})();
