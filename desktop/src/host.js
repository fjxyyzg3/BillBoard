const message = document.getElementById("message");
const retry = document.getElementById("retry");
retry.addEventListener("click", () => window.BillBoardHost.retry());
window.BillBoardHost.subscribe(value => {
  document.documentElement.lang = value.locale === "en-US" ? "en" : "zh-CN";
  document.querySelector("h1").textContent = value.locale === "en-US" ? "Household accounts" : "家庭记账";
  message.textContent = value.message;
  retry.textContent = value.retry;
  retry.hidden = !value.failed;
});
