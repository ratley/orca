import chalk from "chalk";

type LogLevel = "info" | "warn" | "error" | "success";

export interface Logger {
  info: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
  error: (message: string, context?: Record<string, unknown>) => void;
  success: (message: string, context?: Record<string, unknown>) => void;
}

function formatContext(context?: Record<string, unknown>): string {
  if (!context || Object.keys(context).length === 0) {
    return "";
  }

  return ` ${JSON.stringify(context)}`;
}

function colorize(level: LogLevel, line: string): string {
  switch (level) {
    case "info":
      return chalk.blue(line);
    case "warn":
      return chalk.yellow(line);
    case "error":
      return chalk.red(line);
    case "success":
      return chalk.green(line);
    default:
      return line;
  }
}

export function createLogger(prefix = "orca"): Logger {
  const base = `[${prefix}]`;

  const emit = (level: LogLevel, message: string, context?: Record<string, unknown>): void => {
    const line = `${base} ${level.toUpperCase()} ${message}${formatContext(context)}`;
    const colored = colorize(level, line);

    if (level === "error") {
      console.error(colored);
      return;
    }

    console.log(colored);
  };

  return {
    info: (message, context) => emit("info", message, context),
    warn: (message, context) => emit("warn", message, context),
    error: (message, context) => emit("error", message, context),
    success: (message, context) => emit("success", message, context)
  };
}

export const logger = createLogger();
