// 從 paraentr 的 functions/api/whoami.js 複製過來的身分驗證邏輯(比照 parallelserver
// 現有慣例:每個 app 各自複製一份,不共用程式碼)。不做密碼驗證——身分驗證交給 Cloudflare
// Zero Trust Access 處理,這裡只是把 Access 已經確認過的結果讀出來。
//
// 前提:這個 Worker 的自訂網域要落在既有的 `AP Internal Platform` Access Application
// (萬用字元 *.parallelserver.org)底下,Access 才會在邊緣先驗證、把結果夾帶在
// Cf-Access-Authenticated-User-Email 這個 header 裡送進來。
//
// 成員名單異動:改這個表,commit + push 即可,源頭以 paraentr 為準,這裡要跟著同步更新。

const TEAM: Record<string, string> = {
  "theosyl@icloud.com": "ShaoYi",
  "wu.plhojita@gmail.com": "PeiLing",
};

export function whoamiFromHeaders(headers: Headers) {
  const email = headers.get("Cf-Access-Authenticated-User-Email");
  return {
    email: email || null,
    name: (email && TEAM[email]) || null,
  };
}
