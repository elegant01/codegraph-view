// 统一的错误消息提取。
// strict 模式下 catch 到的是 unknown（可能是 Error，也可能是任意抛出物），直接读 .message 不合法。
// 前端 public/app.js 是经典脚本（不是 module，无法 import），那里有一份同名本地实现。
export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
