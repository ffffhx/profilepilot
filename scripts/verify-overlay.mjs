#!/usr/bin/env node

import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const nodeCommand = process.execPath;
const useColor = process.stdout.isTTY;

const colors = {
  red: (value) => (useColor ? `\u001b[31m${value}\u001b[39m` : value),
  green: (value) => (useColor ? `\u001b[32m${value}\u001b[39m` : value),
  yellow: (value) => (useColor ? `\u001b[33m${value}\u001b[39m` : value)
};

let activeChild = null;
let activeStep = null;
let receivedSignal = null;

function usage() {
  console.log("Usage: npm run verify:overlay -- [--with-bench]");
  console.log("");
  console.log("Builds once, then runs overlay unit/e2e/doctor checks in sequence.");
  console.log("Bench is skipped by default; pass --with-bench to include scripts/bench-overlay.mjs.");
}

function parseArgs(argv) {
  const args = { withBench: false };
  for (const arg of argv) {
    if (arg === "--with-bench") {
      args.withBench = true;
    } else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else {
      console.error(`[verify-overlay] Unknown argument: ${arg}`);
      usage();
      process.exit(2);
    }
  }
  return args;
}

function buildSteps({ withBench }) {
  const steps = [
    {
      id: "build",
      name: "build",
      command: npmCommand,
      args: ["run", "build"]
    },
    {
      id: "unit",
      name: "unit tests",
      command: nodeCommand,
      args: ["--test", "tests/"]
    },
    {
      id: "smoke",
      name: "e2e overlay smoke",
      command: nodeCommand,
      args: ["scripts/e2e-overlay-smoke.mjs"]
    },
    {
      id: "stress",
      name: "e2e overlay stress",
      command: nodeCommand,
      args: ["scripts/e2e-overlay-stress.mjs"]
    },
    {
      id: "doctor",
      name: "overlay doctor self-start",
      command: nodeCommand,
      args: ["scripts/overlay-doctor.mjs"]
    }
  ];

  if (withBench) {
    steps.push({
      id: "bench",
      name: "overlay bench",
      command: nodeCommand,
      args: ["scripts/bench-overlay.mjs"]
    });
  }

  return steps;
}

function printDescription({ withBench }) {
  console.log("[verify-overlay] Unified overlay verification entry");
  console.log("[verify-overlay] Build runs once before all checks.");
  console.log(
    "[verify-overlay] Sequence: build -> unit tests -> e2e overlay smoke -> e2e overlay stress -> overlay doctor self-start" +
      (withBench ? " -> overlay bench" : "")
  );
  if (!withBench) {
    console.log("[verify-overlay] Bench skipped by default. Use --with-bench to include it.");
  }
}

function createLineCollector() {
  const buffers = new Map([
    ["stdout", ""],
    ["stderr", ""]
  ]);
  const lastLines = [];
  const keyLines = [];

  function remember(line) {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    lastLines.push(trimmed);
    if (lastLines.length > 8) {
      lastLines.shift();
    }
    if (isKeyOutputLine(trimmed)) {
      keyLines.push(trimmed);
      if (keyLines.length > 12) {
        keyLines.shift();
      }
    }
  }

  return {
    add(streamName, chunk) {
      const text = chunk.toString();
      const buffered = `${buffers.get(streamName) ?? ""}${text}`;
      const lines = buffered.split(/\r?\n/);
      buffers.set(streamName, lines.pop() ?? "");
      for (const line of lines) {
        remember(line);
      }
    },
    finish() {
      for (const [streamName, buffered] of buffers) {
        if (buffered) {
          remember(buffered);
          buffers.set(streamName, "");
        }
      }
      const highlights = keyLines.length ? keyLines : lastLines;
      return highlights.slice(-6);
    }
  };
}

function isKeyOutputLine(line) {
  return (
    /^# (tests|suites|pass|fail|cancelled|skipped|duration_ms)\b/i.test(line) ||
    /\b(PASS|FAILED|ERROR|Summary:|assertions=|not ok)\b/i.test(line) ||
    /^\s*fail\s+\d+/i.test(line)
  );
}

async function runStep(step) {
  const startedAt = performance.now();
  const collector = createLineCollector();

  console.log("");
  console.log(`[verify-overlay] START ${step.name}: ${formatCommand(step.command, step.args)}`);

  const result = await new Promise((resolve) => {
    const child = spawn(step.command, step.args, {
      cwd: process.cwd(),
      detached: process.platform !== "win32",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    activeChild = child;
    activeStep = step.name;

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      collector.add("stdout", chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      collector.add("stderr", chunk);
    });

    child.on("error", (error) => {
      resolve({
        code: 1,
        signal: null,
        error
      });
    });
    child.on("close", (code, signal) => {
      resolve({
        code: code ?? signalExitCode(signal),
        signal,
        error: null
      });
    });
  });

  if (activeChild?.pid) {
    activeChild = null;
    activeStep = null;
  }

  const durationMs = performance.now() - startedAt;
  const keyLines = collector.finish();
  const passed = result.code === 0 && !receivedSignal;
  const status = passed ? "PASS" : "FAIL";

  if (result.error) {
    keyLines.push(result.error.message);
  }

  const statusText = passed ? colors.green("PASS") : colors.red(">>> FAIL <<<");
  console.log(`[verify-overlay] END ${step.name}: ${statusText} (${formatDuration(durationMs)})`);

  return {
    id: step.id,
    name: step.name,
    status,
    passed,
    durationMs,
    exitCode: result.code,
    signal: result.signal,
    keyLines
  };
}

function skippedResult(step, reason) {
  return {
    id: step.id,
    name: step.name,
    status: "SKIP",
    passed: true,
    durationMs: 0,
    exitCode: null,
    signal: null,
    keyLines: [reason]
  };
}

function signalExitCode(signal) {
  if (signal === "SIGINT") {
    return 130;
  }
  if (signal === "SIGTERM") {
    return 143;
  }
  return 1;
}

function installSignalHandlers() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      receivedSignal = signal;
      console.error(
        `[verify-overlay] Received ${signal}${activeStep ? ` during ${activeStep}` : ""}; terminating current child process.`
      );
      terminateActiveChild(signal);
    });
  }
}

function terminateActiveChild(signal) {
  const child = activeChild;
  if (!child?.pid || child.killed) {
    return;
  }

  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The child already exited.
    }
  }

  setTimeout(() => {
    if (!child.killed) {
      try {
        if (process.platform !== "win32") {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        // The child already exited.
      }
    }
  }, 3000).unref();
}

function printSummary(results) {
  console.log("");
  console.log("[verify-overlay] Summary");
  console.log("| Step | Status | Time | Exit | Key output |");
  console.log("| --- | --- | ---: | ---: | --- |");
  for (const result of results) {
    const status =
      result.status === "FAIL"
        ? colors.red(">>> FAIL <<<")
        : result.status === "SKIP"
          ? colors.yellow("SKIP")
          : colors.green("PASS");
    const keyOutput = result.keyLines.length ? result.keyLines.map(summarizeCell).join(" / ") : "-";
    console.log(
      `| ${escapeCell(result.name)} | ${status} | ${formatDuration(result.durationMs)} | ${formatExit(result)} | ${escapeCell(
        keyOutput
      )} |`
    );
  }

  const failed = results.filter((result) => result.status === "FAIL");
  if (failed.length) {
    console.log("");
    console.log(colors.red(`[verify-overlay] Failed steps: ${failed.map((result) => result.name).join(", ")}`));
  } else {
    console.log("");
    console.log(colors.green("[verify-overlay] Overall: PASS"));
  }
}

function formatExit(result) {
  if (result.exitCode === null) {
    return "-";
  }
  if (result.signal) {
    return `${result.exitCode} (${result.signal})`;
  }
  return String(result.exitCode);
}

function formatDuration(ms) {
  if (ms === 0) {
    return "0.0s";
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds - minutes * 60);
  return `${minutes}m ${remainingSeconds}s`;
}

function formatCommand(command, args) {
  const displayCommand = command === nodeCommand ? "node" : command;
  return [displayCommand, ...args].map(quoteArg).join(" ");
}

function quoteArg(arg) {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(arg)) {
    return arg;
  }
  return JSON.stringify(arg);
}

function summarizeCell(line) {
  return line.replace(/\s+/g, " ").slice(0, 180);
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|");
}

async function main() {
  installSignalHandlers();
  const args = parseArgs(process.argv.slice(2));
  printDescription(args);

  const steps = buildSteps(args);
  const results = [];

  for (const step of steps) {
    if (receivedSignal) {
      results.push(skippedResult(step, `Skipped after ${receivedSignal}.`));
      continue;
    }

    const result = await runStep(step);
    results.push(result);

    if (step.id === "build" && result.status === "FAIL") {
      const remaining = steps.slice(steps.indexOf(step) + 1);
      for (const skipped of remaining) {
        results.push(skippedResult(skipped, "Skipped because build failed."));
      }
      break;
    }
  }

  if (!args.withBench) {
    results.push(skippedResult({ id: "bench", name: "overlay bench" }, "Skipped by default; pass --with-bench to run."));
  }

  printSummary(results);

  const failed = results.some((result) => result.status === "FAIL");
  if (receivedSignal) {
    process.exitCode = signalExitCode(receivedSignal);
  } else if (failed) {
    process.exitCode = 1;
  }
}

await main();
