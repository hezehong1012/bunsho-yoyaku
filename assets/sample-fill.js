// V3.0 サンプル一键填充：ページ別の現実的な例文を textarea に流し込む
(function () {
  var SAMPLES = {
    mail: {
      toName: "株式会社サンプル 田中様",
      text: "先日はお忙しい中、お打ち合わせのお時間をいただき誠にありがとうございました。ご相談いただいた見積書を作成し、来週月曜日までにお送りいたします。引き続きどうぞよろしくお願いいたします。"
    },
    kousei: {
      text: "昨日の会議では、新しいサービスの料金について話し合いました。来週までに資料をまとめて、お客様に送る予定です。スケジュールが少し厳しいので、優先順位をつけて進めたいとおもいます。"
    },
    paraphrase: {
      text: "この商品は機能が多くて使いやすいですが、価格が少し高いという意見もあります。今後は価格設定を見直し、より多くのお客様に選んでいただけるようにしたいと考えています。"
    },
    bunsho: {
      text: "今期の売上は前年比108%となり、主な要因は新規顧客の獲得と商品単価の改善でした。一方、物流費の高騰により粗利率は1.2ポイント低下しています。来期は物流網の見直しと新規顧客の継続率改善に注力する方針です。"
    },
    pdf: {
      text: "本レポートでは、2026年第3四半期の市場動向を分析しました。全体の市場規模は前年比105%に拡大し、特に若年層の利用が増加しています。競合他社の新製品投入が相次いだため、差別化が今後の課題です。"
    }
  };

  function detectKey() {
    var p = location.pathname;
    if (p.indexOf('/mail-generator') === 0) return 'mail';
    if (p.indexOf('/kousei') === 0) return 'kousei';
    if (p.indexOf('/paraphrase') === 0) return 'paraphrase';
    if (p.indexOf('/pdf-yoyaku') === 0) return 'pdf';
    if (p.indexOf('/bunsho-yoyaku') === 0) return 'bunsho';
    return null;
  }

  function fire(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  var btn = document.querySelector('.sample-fill');
  if (!btn) return;
  var key = detectKey();
  if (!key) return;
  var sample = SAMPLES[key];

  btn.addEventListener('click', function () {
    if (sample.toName) {
      var tn = document.getElementById('toName');
      if (tn) { tn.value = sample.toName; fire(tn); }
    }
    var ta = document.getElementById('inputText') || document.getElementById('bodyText');
    if (ta) {
      ta.value = sample.text;
      fire(ta);
      ta.focus();
    }
  });
})();
