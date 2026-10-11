// New videos should arrive with title, series, season and episode read from their file names.
const w = ms => new Promise(r => setTimeout(r, ms)); const $ = id => document.getElementById(id); const r = {};
(async () => { try {
  await w(1000); location.hash = '#/admin'; await w(300); $('gate-pw').value = window.__pw; $('gate').requestSubmit(); await w(1500); $('signin-btn').click(); await w(800);
  const dt = new DataTransfer();
  dt.items.add(new File(['x'], 'Road.Trip.S01E04.Desert.Night.1080p.mp4', { type: 'video/mp4' }));
  dt.items.add(new File(['x'], 'my_holiday_video (1).mp4', { type: 'video/mp4' }));
  window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, cancelable: true })); await w(2500);
  r.queue = [...document.querySelectorAll('#queue-list li')].map(li => li.className + ': ' + li.querySelector('.q-line').textContent);
  $('admin-pick').click(); await w(800); r.toast = $('toast').textContent;
  r.rows = [...document.querySelectorAll('.admin-row')].slice(0, 3).map(e => e.querySelector('strong').textContent + ' [' + e.querySelector('.card-text span').textContent.split(' · ').slice(2).join(' · ') + ']');
} catch (e) { r.fail = String(e.stack || e); }
  const pre = document.createElement('pre'); pre.id = 'result'; pre.textContent = JSON.stringify(r, null, 1); pre.style.display = 'none'; document.body.appendChild(pre); })();
