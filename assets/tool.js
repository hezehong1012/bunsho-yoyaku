// AI要約くん 共通ツールロジック
// ページ側に要素ID: inputText, charCount, maxLength, tone, keyword, ngword, scene,
// submitBtn, loading, resultBox, resultText, resultCount, copyBtn, retryBtn が必要

(function () {
  var MAX = 5000;
  function $(id) { return document.getElementById(id); }

  function initTool() {
    var input = $('inputText');
    var charCount = $('charCount');
    var submitBtn = $('submitBtn');
    var loading = $('loading');
    var resultBox = $('resultBox');
    var resultText = $('resultText');
    var resultCount = $('resultCount');
    var copyBtn = $('copyBtn');
    var retryBtn = $('retryBtn');
    if (!input) return;

    function renderCount() {
      if (input.value.length > MAX) input.value = input.value.substring(0, MAX);
      charCount.textContent = input.value.length + ' / ' + MAX + '文字';
    }
    input.addEventListener('input', renderCount);
    renderCount();

    // シーンプリセット: キーワード欄へ反映 + 追加メモ
    document.querySelectorAll('[data-scene]').forEach(function (b) {
      b.addEventListener('click', function () {
        var sc = b.getAttribute('data-scene');
        $('scene').value = sc;
        document.querySelectorAll('[data-scene]').forEach(function (x) {
          x.classList.toggle('active', x === b);
        });
      });
    });

    function run() {
      var text = input.value.trim();
      if (!text) { alert('要約する文章を入力してください。'); return; }
      if (text.length < 50) { alert('50文字以上入力してください。'); return; }

      var toneEl = document.querySelector('input[name="tone"]:checked');
      var payload = {
        text: text,
        max_length: parseInt(($('maxLength') || {}).value, 10) || 200,
        tone: toneEl ? toneEl.value : 'desu',
        keyword: $('keyword') ? $('keyword').value : '',
        ngword: $('ngword') ? $('ngword').value : '',
        scene: $('scene') ? $('scene').value : 'general'
      };

      submitBtn.disabled = true;
      loading.style.display = 'block';
      resultBox.style.display = 'none';

      fetch('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (out) {
          if (!out.ok) throw new Error(out.j.error || 'エラーが発生しました。');
          resultText.textContent = out.j.summary;
          if (resultCount) resultCount.textContent = out.j.summary.length + '文字';
          resultBox.style.display = 'block';
          resultBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        })
        .catch(function (e) { alert(e.message); })
        .finally(function () {
          submitBtn.disabled = false;
          loading.style.display = 'none';
        });
    }

    submitBtn.addEventListener('click', run);

    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        navigator.clipboard.writeText(resultText.textContent).then(function () {
          copyBtn.textContent = 'コピーしました';
          setTimeout(function () { copyBtn.textContent = 'コピーする'; }, 1500);
        });
      });
    }
    if (retryBtn) retryBtn.addEventListener('click', run);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTool);
  } else {
    initTool();
  }
})();
