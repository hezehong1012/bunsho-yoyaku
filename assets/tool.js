// AI要約くん 共通フロント V1.3（要約 / 情報抽出 タブ、URL自動検出、長文15,000文字対応）
(function () {
  var MAX_SUMMARY = 15000; // 要約APIの上限（サーバー側で分割要約）
  var MAX_EXTRACT = 5000;  // 情報抽出APIの上限
  function $(id) { return document.getElementById(id); }

  function init() {
    var input = $('inputText');
    var charCount = $('charCount');
    if (!input) return;

    function currentMax() { return mode === 'extract' ? MAX_EXTRACT : MAX_SUMMARY; }

    function renderCount() {
      var m = currentMax();
      if (input.value.length > m) input.value = input.value.substring(0, m);
      charCount.textContent = input.value.length + ' / ' + m + '文字';
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
        renderCount();
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

    // 結果の連携：要約 → 言い換え／校正（localStorage 経由で受け渡し）
    var chainBar = null;
    if (resultBox) {
      var actionsEl = resultBox.querySelector('.actions');
      if (actionsEl) {
        chainBar = document.createElement('div');
        chainBar.id = 'chainBar';
        chainBar.className = 'actions';
        chainBar.style.display = 'none';
        chainBar.style.marginTop = '10px';
        chainBar.innerHTML =
          '<button type="button" class="btn secondary" id="chainParaphrase">この要約を言い換える</button>' +
          '<button type="button" class="btn secondary" id="chainKousei">この要約を校正する</button>';
        actionsEl.parentNode.insertBefore(chainBar, actionsEl.nextSibling);
        function goChain(path) {
          var text = (resultText && resultText.textContent) || '';
          if (!text) return;
          try {
            localStorage.setItem('aiyoyaku_handoff', JSON.stringify({ text: text, ts: Date.now() }));
          } catch (e) { /* localStorage 不可の環境では遷移のみ */ }
          location.href = path + '?from=summary';
        }
        var cp = document.getElementById('chainParaphrase');
        var ck = document.getElementById('chainKousei');
        if (cp) cp.addEventListener('click', function () { goChain('/paraphrase/'); });
        if (ck) ck.addEventListener('click', function () { goChain('/kousei/'); });
      }
    }

    function hideResult() {
      resultBox.style.display = 'none';
      if (resultText) resultText.textContent = '';
      if (resultTableWrap) resultTableWrap.style.display = 'none';
      if (chainBar) chainBar.style.display = 'none';
    }

    function basePayload() {
      var toneEl = document.querySelector('input[name="tone"]:checked');
      var formEl = document.querySelector('input[name="outputform"]:checked');
      return {
        text: input.value.trim(),
        max_length: parseInt(($('maxLength') || {}).value, 10) || 200,
        tone: toneEl ? toneEl.value : 'desu',
        output_form: formEl ? formEl.value : 'paragraph',
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

    var formError = $('formError');
    function showError(msg) {
      if (!formError) { if (window.alert) alert(msg); return; }
      formError.textContent = msg;
      formError.classList.add('show');
      formError.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      input.focus();
    }
    function clearError() {
      if (formError) formError.classList.remove('show');
    }
    input.addEventListener('input', clearError);

    function run() {
      clearError();
      var text = input.value.trim();
      var hasUrl = /https?:\/\//.test(text);
      if (!text) { showError('文章またはURLを入力してください。'); return; }
      if (text.length < 50 && !hasUrl) {
        showError('50文字以上入力してください（現在 ' + text.length + ' 文字）。URLが含まれる場合は短くても構いません。');
        return;
      }
      var limit = currentMax();
      if (text.length > limit) {
        showError((mode === 'extract' ? '情報抽出は' : '要約は') + limit.toLocaleString() + '文字以内で入力してください（現在 ' + text.length.toLocaleString() + ' 文字）。');
        return;
      }

      var isExtract = mode === 'extract';
      var payload = basePayload();
      var endpoint = '/api/summarize';
      if (isExtract) {
        payload.fields = $('fields').value;
        if (!String(payload.fields || '').trim()) { showError('抽出したい項目（フィールド）を1つ以上入力してください。'); return; }
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
            if (resultCount) {
              resultCount.textContent = out.j.summary.length + '文字' +
                (out.j.chunked ? '（長文を' + out.j.chunked + '分割して要約）' : '') +
                (out.j.cached ? '・キャッシュ' : '');
            }
            if (chainBar) chainBar.style.display = 'flex';
          }
          resultBox.style.display = 'block';
          resultBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        })
        .catch(function (e) { showError(e.message); })
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
    function fallbackCopy(text) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      return ok;
    }
    function flashCopied(ok) {
      var oldTxt = 'コピーする';
      copyBtn.textContent = ok ? 'コピー済み ✓' : 'コピーできませんでした';
      copyBtn.classList.toggle('copied', ok);
      setTimeout(function () {
        copyBtn.textContent = oldTxt;
        copyBtn.classList.remove('copied');
      }, 1500);
    }
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        var data = mode === 'extract'
          ? (function () { var rows = resultTable.querySelectorAll('tr'); var o = {}; rows.forEach(function (r) { o[r.cells[0].textContent] = r.cells[1].textContent; }); return JSON.stringify(o, null, 2); })()
          : resultText.textContent;
        var done = function (ok) { flashCopied(ok); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(data)
            .then(function () { done(true); })
            .catch(function () { done(fallbackCopy(data)); });
        } else {
          done(fallbackCopy(data));
        }
      });
    }
    if (retryBtn) retryBtn.addEventListener('click', run);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
