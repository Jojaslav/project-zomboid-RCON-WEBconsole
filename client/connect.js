const $ = (id) => document.getElementById(id);

async function connect(address) {
  $('error').textContent = '';
  $('connect').disabled = true;
  $('connect').textContent = 'Connecting…';
  const result = await window.pzSetup.connect(address);
  if (!result.ok) {
    $('error').textContent = result.error;
    $('connect').disabled = false;
    $('connect').textContent = 'Connect';
  }
}

function renderRecent(servers) {
  $('recent-box').hidden = servers.length === 0;
  const list = $('recent');
  list.replaceChildren();
  for (const origin of servers) {
    const item = document.createElement('li');
    const use = Object.assign(document.createElement('button'), { type: 'button', textContent: origin });
    use.onclick = () => connect(origin);
    const forget = Object.assign(document.createElement('button'), { type: 'button', textContent: '×', title: 'Forget' });
    forget.onclick = async () => renderRecent((await window.pzSetup.forget(origin)).servers);
    item.append(use, forget);
    list.append(item);
  }
}

$('form').onsubmit = (event) => { event.preventDefault(); connect($('address').value); };

(async () => {
  const { last, servers } = await window.pzSetup.list();
  renderRecent(servers);
  if (last) $('address').value = last;
})();
