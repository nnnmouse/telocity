import { spawn } from "node:child_process";

export function tryLaunch(
  cmd: string,
  filePath: string,
  timeout = 200,
): Promise<boolean> {
  return new Promise((resolve) => {
    const launchCommand = `${cmd} "${filePath}"`;
    const child = spawn(launchCommand, {
      stdio: "inherit",
      shell: true,
      detached: true,
    });

    let handled = false;

    const finalize = (success: boolean) => {
      if (handled) return;
      handled = true;
      if (success) child.unref();
      child.removeAllListeners();
      resolve(success);
    };

    child.on("error", () => finalize(false));
    child.on("close", (code) => finalize(code === 0 || code === null));

    const timer = setTimeout(() => finalize(true), timeout);
    const clearHandlers = () => clearTimeout(timer);
    child.on("error", clearHandlers);
    child.on("close", clearHandlers);
  });
}
