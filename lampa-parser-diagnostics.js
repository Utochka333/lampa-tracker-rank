/* Lampa Public Parser Diagnostics v1.0.0
 * Checks public Jackett/JacRed-compatible JSON endpoints from INSIDE Lampa.
 * Does not change Lampa settings, request torrents for playback, or store credentials.
 */
(function () {
  'use strict';
  var VERSION = '1.0.0';
  if (window.LampaParserDiagnostics && window.LampaParserDiagnostics.version === VERSION) {
    window.LampaParserDiagnostics.open();
    return;
  }
  var ROOT_ID = 'lpd-panel-root', LAUNCH_ID = 'lpd-launcher', STYLE_ID = 'lpd-styles';
  var ui = null, results = [], controller = null, started = false;
  var ENDPOINT = '/api/v2.0/indexers/all/results';
  var testQuery = { Query: 'The Matrix', title: 'Матрица', title_original: 'The Matrix', year: '1999', is_serial: '0' };
  var servers = [
    { label: 'jac.stull.xyz (основной)', base: 'https://jac.stull.xyz', key: '1' },
    { label: 'jac.black (дополнительный)', base: 'http://jac.black', key: '' }
  ];

  function el(tag, attrs, parent, text) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (key === 'className') node.className = attrs[key];
      else if (key === 'type') node.type = attrs[key];
      else node.setAttribute(key, attrs[key]);
    });
    if (text !== undefined) node.textContent = text;
    if (parent) parent.appendChild(node);
    return node;
  }
  function css() {
    if (document.getElementById(STYLE_ID)) return;
    var node = el('style', { id: STYLE_ID }, document.head || document.documentElement);
    node.textContent = [
      '#'+ROOT_ID+'{position:fixed;z-index:2147483645;inset:0;background:rgba(0,0,0,.83);display:flex;align-items:center;justify-content:center;padding:2vw;color:#eef2ef;font:16px/1.45 Arial,sans-serif}',
      '#'+ROOT_ID+' *{box-sizing:border-box}',
      '#'+ROOT_ID+' .lpd-box{width:min(900px,96vw);max-height:94vh;overflow:auto;background:#17201c;border:1px solid #365244;border-radius:14px;padding:22px;box-shadow:0 8px 60px #000a}',
      '#'+ROOT_ID+' h2{font-size:23px;margin:0 0 6px}',
      '#'+ROOT_ID+' p{color:#bacac0;margin:5px 0 13px}',
      '#'+ROOT_ID+' .lpd-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:10px 0}',
      '#'+ROOT_ID+' .lpd-card{padding:12px;margin:10px 0;border:1px solid #3a5147;border-radius:9px;background:#202b25}',
      '#'+ROOT_ID+' .lpd-card strong{display:block;margin-bottom:7px}',
      '#'+ROOT_ID+' .lpd-good{color:#72e6a2} #'+ROOT_ID+' .lpd-warn{color:#efc565} #'+ROOT_ID+' .lpd-fail{color:#f8958e}',
      '#'+ROOT_ID+' button,#'+ROOT_ID+' input{font:inherit;border-radius:7px;min-height:39px}',
      '#'+ROOT_ID+' button{border:1px solid #6b947c;background:#284936;color:#fff;padding:7px 13px;cursor:pointer}',
      '#'+ROOT_ID+' button:focus,#'+ROOT_ID+' input:focus{outline:3px solid #f0be61;outline-offset:2px}',
      '#'+ROOT_ID+' button:disabled{opacity:.45;cursor:default}',
      '#'+ROOT_ID+' input{background:#101a16;color:#fff;border:1px solid #658072;padding:8px;width:min(360px,100%)}',
      '#'+ROOT_ID+' .lpd-label{font-size:13px;color:#acbcb0}',
      '#'+ROOT_ID+' .lpd-report{white-space:pre-wrap;overflow-wrap:anywhere;color:#d9e6dd;font-family:monospace;font-size:12px;background:#0d1611;padding:12px;border-radius:7px}',
      '#'+LAUNCH_ID+'{position:fixed;bottom:12px;right:12px;z-index:2147483643;background:#244a35;color:#f4fff5;border:1px solid #579e71;border-radius:7px;padding:8px 10px;font:14px Arial,sans-serif;cursor:pointer}',
      '#'+LAUNCH_ID+':focus{outline:3px solid #e7c063}'
    ].join('\n');
  }
  function close() { if (ui && ui.root) ui.root.remove(); ui = null; }
  function render() {
    close(); css();
    var root = el('div', {id:ROOT_ID, role:'dialog', 'aria-label':'Диагностика публичных парсеров'}, document.body);
    var box = el('div', {className:'lpd-box'}, root);
    var row = el('div', {className:'lpd-row'}, box);
    el('h2', {}, row, '🔎 Проверка парсеров Lampa');
    var closeBtn = el('button', {type:'button'}, row, 'Закрыть'); closeBtn.addEventListener('click', close);
    el('p', {}, box, 'Проверка выполняется прямо из Lampa. Фильм: «Матрица» (1999). Результаты показывают доступность API и браузерного запроса.');
    el('p', {}, box, 'Основной API-ключ: 1. Для jac.black можно указать свой ключ из настроек Lampa. Он не сохраняется и не попадает в отчёт.');
    var controls = el('div', {className:'lpd-row'}, box);
    var input = el('input', {type:'password',placeholder:'API-ключ jac.black (необязательно)',autocomplete:'off','aria-label':'API-ключ jac.black'}, controls);
    var runBtn = el('button', {type:'button'}, controls, '▶ Проверить оба');
    var stopBtn = el('button', {type:'button'}, controls, 'Остановить'); stopBtn.disabled = true;
    var copyBtn = el('button', {type:'button'}, controls, 'Скопировать отчёт');
    var status = el('div', {className:'lpd-label'}, box, 'Готов к проверке.');
    var cards = el('div', {}, box);
    var report = el('pre', {className:'lpd-report'}, box, 'Отчёт появится после проверки.');
    el('p', {className:'lpd-label'}, box, 'При ошибке CORS / Failed to fetch это может быть CORS, Mixed Content, DNS или недоступность сайта — по одному сообщению различить нельзя. Проверка не подтверждает скорость потокового воспроизведения.');
    ui = {root:root,input:input,runBtn:runBtn,stopBtn:stopBtn,status:status,cards:cards,report:report};
    runBtn.addEventListener('click', run);
    stopBtn.addEventListener('click', function(){ if(controller)controller.abort(); });
    copyBtn.addEventListener('click', function(){
      var data = report.textContent;
      if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(data).then(function(){status.textContent='Отчёт скопирован.';}).catch(function(){status.textContent='Не удалось скопировать. Можно выделить текст отчёта.';});
      else status.textContent='Копирование не поддерживается. Можно выделить текст отчёта.';
    });
    closeBtn.focus();
  }
  function classify(err, timedOut) {
    if(timedOut)return 'Тайм-аут — сервер не ответил за 12 секунд';
    if(err && err.name==='AbortError')return 'Запрос остановлен';
    return 'Сетевая ошибка: возможны CORS, Mixed Content, DNS, TLS или блокировка. '+ String(err&&err.message||err).slice(0,140);
  }
  function request(server, signal) {
    var url = server.base + ENDPOINT + '?' + Object.keys(testQuery).map(function(k){return encodeURIComponent(k)+'='+encodeURIComponent(testQuery[k]);}).join('&') + '&apikey=' + encodeURIComponent(server.key);
    var aborter = new AbortController();
    var didTimeout = false;
    var onAbort = function(){aborter.abort();};
    signal.addEventListener('abort', onAbort);
    var timer = setTimeout(function(){didTimeout=true;aborter.abort();},12000);
    var startedAt = Date.now();
    return fetch(url, {method:'GET',mode:'cors',cache:'no-store',credentials:'omit',signal:aborter.signal}).then(function(res){
      var status = res.status;
      return res.text().then(function(body){
        var parsed;
        try { parsed=JSON.parse(body); } catch(e) { return {status:'error',http:status,elapsed:Date.now()-startedAt,reason:'Ответ не JSON. Первые символы: '+body.slice(0,90)}; }
        var arr=Array.isArray(parsed.Results)?parsed.Results:Array.isArray(parsed.results)?parsed.results:null;
        if(!res.ok)return {status:'error',http:status,elapsed:Date.now()-startedAt,reason:typeof parsed.Error==='string'?parsed.Error:'HTTP '+status};
        if(!arr)return {status:'error',http:status,elapsed:Date.now()-startedAt,reason:'JSON получен, но массива Results нет. Поля: '+Object.keys(parsed).slice(0,9).join(', ')};
        var allowed=/rutracker|kinozal|rutor|nnmclub|nnm-club|torrentby|torrent\.by/i;
        var allowedCount=arr.filter(function(x){return allowed.test(String(x.Tracker||x.tracker||''));}).length;
        return {status:'ok',http:status,elapsed:Date.now()-startedAt,count:arr.length,allowed:allowedCount,hasMeta:!!(arr[0]&&(arr[0].ffprobe||arr[0].MediaInfo||arr[0].voices)),sampleTracker:String(arr[0]&&(arr[0].Tracker||arr[0].tracker)||'не указан').slice(0,120)};
      });
    }).catch(function(e){return {status:'error',elapsed:Date.now()-startedAt,reason:classify(e,didTimeout)};}).then(function(result){
      clearTimeout(timer);signal.removeEventListener('abort',onAbort);return result;
    });
  }
  function addResult(server, result) {
    if(!ui)return;
    var card=el('div',{className:'lpd-card'},ui.cards);
    el('strong',{},card,server.label);
    var ok=result.status==='ok';
    el('div',{className:ok?'lpd-good':'lpd-fail'},card,ok?'✓ Доступен':'✕ Ошибка');
    if(result.http!==undefined)el('div',{},card,'HTTP: '+result.http);
    el('div',{},card,'Время: '+result.elapsed+' мс');
    if(ok){
      el('div',{},card,'Всего результатов: '+result.count+' · из пяти разрешённых источников: '+result.allowed);
      el('div',{},card,'Пример Tracker: '+result.sampleTracker);
      el('div',{},card,'Дополнительные метаданные в первом результате: '+(result.hasMeta?'да':'не обнаружены'));
    } else el('div',{className:'lpd-warn'},card,result.reason||'Неизвестная ошибка');
  }
  function buildReport() {
    return [
      'Lampa Public Parser Diagnostics '+VERSION,
      'Origin: '+location.origin,
      'Protocol: '+location.protocol,
      'Time (local): '+new Date().toLocaleString(),
      'Query: The Matrix (1999)',
      // Never include API keys or full request URL.
      results.map(function(e){var r=e.result;return e.server.label+' | '+(r.status==='ok'?'OK':'ERROR')+' | HTTP '+(r.http===undefined?'?':r.http)+' | '+r.elapsed+' ms'+(r.status==='ok'?' | Results '+r.count+' | Allowed '+r.allowed+' | Metadata '+r.hasMeta:' | '+r.reason);}).join('\n')
    ].join('\n');
  }
  async function run() {
    if(!ui||started)return;
    started=true;results=[];
    controller=new AbortController();
    var state=ui; state.cards.textContent='';state.runBtn.disabled=true;state.stopBtn.disabled=false;
    var all=[{label:servers[0].label,base:servers[0].base,key:servers[0].key},{label:servers[1].label,base:servers[1].base,key:state.input.value.trim()||'1'}];
    state.status.textContent='Запросы выполняются. Не закрывай карточку до завершения теста.';
    for(var i=0;i<all.length;i++){
      state.status.textContent='Проверка '+(i+1)+'/2: '+all[i].label;
      var result=await request(all[i],controller.signal);
      results.push({server:{label:all[i].label},result:result});
      addResult(all[i],result);
      if(controller.signal.aborted)break;
    }
    state.report.textContent=buildReport();
    state.status.textContent='Готово. Скопируй отчёт и пришли его в чат.';
    state.runBtn.disabled=false;state.stopBtn.disabled=true;
    state.input.value='';controller=null;started=false;
  }
  function launch(){
    css();
    if(!document.getElementById(LAUNCH_ID)){
      var button=el('button',{id:LAUNCH_ID,type:'button'},document.body,'API тест');
      button.addEventListener('click',render);
    }
    render();
  }
  window.LampaParserDiagnostics={version:VERSION,open:render,close:close,run:run};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',launch,{once:true});else launch();
})();
