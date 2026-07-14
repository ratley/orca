#!/usr/bin/env node

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };

import { runLaneCli } from "./lane-commands.js";

process.exitCode = await runLaneCli(process.argv.slice(2), { version });
