// AI要約くん 共通フロント V1.2（要約 / 情報抽出 タブ、URL自動検出）
(function () {
  var MAX = 5000;
  function $(id) { return document.getElementById(id); }

  function init() {
    var input = $('inputText');
    var charCount = $('charCount');
    if (!input) return;

    function renderCount() {
      if (input.value.length > MAX) input.value = input.value.substring(0, MAX);
      charCount.textContent = input.value.length + ' / ' + MAX + '文字';
      detectUrl();
    }
    input.addEventListener('input', renderCount);
    renderCount();

    // タブ切替
    var mode = 'summary';
    var sumPanel = $('summaryPanel');
    var extPanel = $('extractPanel');
    document.querySelectorAll('[data-mode]').forEach(function (b) {
      b.addEventListener('click', function () {
        mode = b.getAttribute('data-mode');
        document.querySelectorAll('[data-mode]').forEach(function (x) { x.classList.toggle('active', x === b); });
        if (sumPanel) sumPanel.style.display = mode === 'summary' ? 'block' : 'none';
        if (extPanel) extPanel.style.display = mode === 'extract' ? 'block' : 'none';
        var btn = $('submitBtn');
        btn.textContent = mode === 'summary' ? '要約する' : '情報を抽出する';
        hideResult();
      });
    });

    // URL検出ヒント
    var urlHint = $('urlHint');
    var urlRe = /https?:\/\/[^\s<>"'，。、）)】\]]+/g;
    function detectUrl() {
      if (!urlHint) return;
      var n = (input.value.match(urlRe) || []).length;
      urlHint.style.display = n ? 'block' : 'none';
      urlHint.textContent = n
        ? '🔗 ' + n + '件のURLを検出しました。実行時にページ本文を自動取得して処理します。'
        : '';
    }

    // シーンプリセット
    document.querySelectorAll('[data-scene]').forEach(function (b) {
      b.addEventListener('click', function () {
        $('scene').value = b.getAttribute('data-scene');
        document.querySelectorAll('[data-scene]').forEach(function (x) { x.classList.toggle('active', x === b); });
      });
    });

    // フィールドプリセット
    document.querySelectorAll('[data-fields]').forEach(function (b) {
      b.addEventListener('click', function () { $('fields').value = b.getAttribute('data-fields'); });
    });

    var loading = $('loading');
    var resultBox = $('resultBox');
    var resultText = $('resultText');
    var resultTableWrap = $('resultTableWrap');
    var resultTable = $('resultTable');
    var resultCount = $('resultCount');
    var copyBtn = $('copyBtn');
    var retryBtn = $('retryBtn');
    var submitBtn = $('submitBtn');

    function hideResult() {
      resultBox.style.display = 'none';
      if (resultText) resultText.textContent = '';
      if (resultTableWrap) resultTableWrap.style.display = 'none';
    }

    function basePayload() {
      var toneEl = document.querySelector('input[name="tone"]:checked');
      return {
        text: input.value.trim(),
        max_length: parseInt(($('maxLength') || {}).value, 10) || 200,
        tone: toneEl ? toneEl.value : 'desu',
        keyword: $('keyword') ? $('keyword').value : '',
        ngword: $('ngword') ? $('ngword').value : '',
        scene: $('scene') ? $('scene').value : 'general'
      };
    }

    function renderFetched(list) {
      var el = $('fetchedInfo');
      if (!el) return;
      if (list && list.length) {
        el.style.display = 'block';
        el.textContent = '🌐 ' + list.length + 'ページを取得して処理しました（' + list.map(function (p) { return p.length + '文字'; }).join('・') + '）';
      } else { el.style.display = 'none'; }
    }

    function run() {
      var text = input.value.trim();
      if (!text) { alert('文章またはURLを入力してください。'); return; }
      if (text.length < 50 && !/https?:\/\//.test(text)) { alert('50文字以上入力してください（URLが含まれる場合は短くても構いません）。'); return; }

      var isExtract = mode === 'extract';
      var payload = basePayload();
      var endpoint = '/api/summarize';
      if (isExtract) {
        payload.fields = $('fields').value;
        if (!String(payload.fields || '').trim()) { alert('抽出したい項目（フィールド）を入力してください。'); return; }
        endpoint = '/api/extract';
      }

      submitBtn.disabled = true;
      loading.style.display = 'block';
      hideResult();

      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (out) {
          if (!out.ok) throw new Error(out.j.error || 'エラーが発生しました。');
          renderFetched(out.j.fetched);
          if (isExtract) {
            renderTable(out.j.result || {});
          } else {
            resultText.textContent = out.j.summary;
            if (resultText) resultText.parentElement.style.display = 'block';
            if (resultCount) resultCount.textContent = out.j.summary.length + '文字';
          }
          resultBox.style.display = 'block';
          resultBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        })
        .catch(function (e) { alert(e.message); })
        .finally(function () {
          submitBtn.disabled = false;
          loading.style.display = 'none';
        });
    }

    function renderTable(obj) {
      if (resultText) resultText.parentElement.style.display = 'none';
      resultTableWrap.style.display = 'block';
      var html = '';
      Object.keys(obj).forEach(function (k) {
        html += '<tr><th>' + escapeHtml(k) + '</th><td>' + escapeHtml(obj[k]) + '</td></tr>';
      });
      resultTable.innerHTML = html;
    }
    function escapeHtml(s) {
      return String(s).replace(/[&<>"]/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
      });
    }

    submitBtn.addEventListener('click', run);
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        var data = mode === 'extract'
          ? (function () { var rows = resultTable.querySelectorAll('tr'); var o = {}; rows.forEach(function (r) { o[r.cells[0].textContent] = r.cells[1].textContent; }); return JSON.stringify(o, null, 2); })()
          : resultText.textContent;
        navigator.clipboard.writeText(data).then(function () {
          copyBtn.textContent = 'コピーしました';
          setTimeout(function () { copyBtn.textContent = 'コピーする'; }, 1500);
        });
      });
    }
    if (retryBtn) retryBtn.addEventListener('click', run);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
