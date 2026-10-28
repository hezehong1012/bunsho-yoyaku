// 言い換え（リライト）ページ専用フロント
(function () {
  var MAX = 5000;
  function $(id) { return document.getElementById(id); }

  function init() {
    var input = $('inputText');
    var charCount = $('charCount');
    var formError = $('formError');
    var loading = $('loading');
    var resultBox = $('resultBox');
    var resultText = $('resultText');
    var resultCount = $('resultCount');
    var submitBtn = $('submitBtn');
    var copyBtn = $('copyBtn');
    var retryBtn = $('retryBtn');
    if (!input) return;

    input.addEventListener('input', function () {
      if (input.value.length > MAX) input.value = input.value.slice(0, MAX);
      charCount.textContent = input.value.length + ' / ' + MAX + '文字';
      formError.classList.remove('show');
    });
    charCount.textContent = '0 / ' + MAX + '文字';

    var mode = 'standard';
    document.querySelectorAll('[data-mode]').forEach(function (b) {
      b.addEventListener('click', function () {
        mode = b.getAttribute('data-mode');
        document.querySelectorAll('[data-mode]').forEach(function (x) { x.classList.toggle('active', x === b); });
      });
    });

    function showError(msg) {
      formError.textContent = msg;
      formError.classList.add('show');
      input.focus();
    }

    function run() {
      formError.classList.remove('show');
      var text = input.value.trim();
      if (!text) { showError('言い換えする文章を入力してください。'); return; }
      if (text.length < 50) { showError('50文字以上入力してください（現在 ' + text.length + ' 文字）。'); return; }
      submitBtn.disabled = true;
      loading.style.display = 'block';
      resultBox.style.display = 'none';
      fetch('/api/paraphrase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text, mode: mode })
      })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (out) {
          if (!out.ok) throw new Error(out.j.error || 'エラーが発生しました。');
          resultText.textContent = out.j.result;
          resultCount.textContent = out.j.result.length + '文字';
          resultBox.style.display = 'block';
          resultBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        })
        .catch(function (e) { showError(e.message); })
        .finally(function () {
          submitBtn.disabled = false;
          loading.style.display = 'none';
        });
    }
    submitBtn.addEventListener('click', run);
    if (retryBtn) retryBtn.addEventListener('click', run);

    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        var data = resultText.textContent;
        function flash(ok) {
          copyBtn.textContent = ok ? 'コピー済み ✓' : 'コピーできませんでした';
          copyBtn.classList.toggle('copied', ok);
          setTimeout(function () { copyBtn.textContent = 'コピーする'; copyBtn.classList.remove('copied'); }, 1500);
        }
        function fb() {
          var ta = document.createElement('textarea');
          ta.value = data; ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select();
          var ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
          document.body.removeChild(ta); return ok;
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(data).then(function(){flash(true);}).catch(function(){flash(fb());});
        } else { flash(fb()); }
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
