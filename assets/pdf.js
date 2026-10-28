// PDF要約ページ専用フロント：pdf.js（CDN）でクライアント側テキスト抽出 → /api/summarize
(function () {
  var MAX = 20000; // PDF本文の上限
  function $(id) { return document.getElementById(id); }

  // pdf.js ワーカー設定
  var pdfjsLib = window.pdfjsLib;
  if (pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  function init() {
    var fileInput = $('pdfFile');
    var fileLabel = $('fileName');
    var textArea = $('inputText');
    var charCount = $('charCount');
    var formError = $('formError');
    var loading = $('loading');
    var resultBox = $('resultBox');
    var resultText = $('resultText');
    var resultCount = $('resultCount');
    var submitBtn = $('submitBtn');
    var copyBtn = $('copyBtn');
    var retryBtn = $('retryBtn');
    if (!fileInput) return;

    var extracted = '';

    function showError(msg) {
      formError.textContent = msg;
      formError.classList.add('show');
    }
    function clearError() { formError.classList.remove('show'); }

    function setCount(n) { charCount.textContent = n + ' / ' + MAX + '文字'; }

    fileInput.addEventListener('change', function () {
      clearError();
      var f = fileInput.files[0];
      if (!f) return;
      if (f.size > 20 * 1024 * 1024) {
        showError('ファイルサイズは20MB以内にしてください。');
        fileInput.value = '';
        return;
      }
      fileLabel.textContent = f.name + '（' + Math.round(f.size / 1024) + 'KB）を解析中…';
      var reader = new FileReader();
      reader.onload = function () {
        var data = new Uint8Array(reader.result);
        pdfjsLib.getDocument({ data: data }).promise.then(function (pdf) {
          var pages = [];
          var chain = Promise.resolve();
          for (var i = 1; i <= pdf.numPages; i++) {
            (function (n) {
              chain = chain.then(function () {
                return pdf.getPage(n).then(function (page) {
                  return page.getTextContent().then(function (tc) {
                    var t = tc.items.map(function (it) { return it.str; }).join(' ');
                    pages.push(t);
                  });
                });
              });
            })(i);
          }
          return chain.then(function () { return pages.join('\n'); });
        }).then(function (text) {
          extracted = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
          if (extracted.length > MAX) extracted = extracted.slice(0, MAX);
          textArea.value = extracted;
          setCount(extracted.length);
          fileLabel.textContent = f.name + '：テキスト抽出完了（' + pdfName(f) + '）';
          if (extracted.length < 50) {
            showError('PDFから文字をほとんど抽出できませんでした。画像PDF（スキャン）には対応していません。テキストを直接貼り付けることもできます。');
          }
        }).catch(function () {
          fileLabel.textContent = '';
          showError('PDFの解析に失敗しました。テキスト形式のPDFをアップロードするか、文章を直接貼り付けてください。');
        });
      };
      reader.readAsArrayBuffer(f);
    });

    function pdfName(f) { return f.name; }

    textArea.addEventListener('input', function () {
      if (textArea.value.length > MAX) textArea.value = textArea.value.slice(0, MAX);
      setCount(textArea.value.length);
    });
    setCount(0);

    function run() {
      clearError();
      var text = textArea.value.trim();
      if (text.length < 50) { showError('要約する文章を50文字以上入力してください（PDFをアップロードするか本文を貼り付け）。'); return; }
      var toneEl = document.querySelector('input[name="tone"]:checked');
      var formEl = document.querySelector('input[name="outputform"]:checked');
      var payload = {
        text: text,
        max_length: parseInt($('maxLength').value, 10) || 300,
        tone: toneEl ? toneEl.value : 'desu',
        output_form: formEl ? formEl.value : 'paragraph',
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
          resultCount.textContent = out.j.summary.length + '文字';
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
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(data).then(function(){flash(true);}).catch(function(){flash(fb());});
        } else { flash(fb()); }
        function fb() {
          var ta = document.createElement('textarea');
          ta.value = data; ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select();
          var ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
          document.body.removeChild(ta); return ok;
        }
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
