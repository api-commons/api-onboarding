#!/usr/bin/env node
/**
 * api-onboard.mjs — the generic API onboarding engine.
 *
 * Reads an API Onboarding Descriptor (local path or URL), reports what the
 * provider requires, executes the descriptor's flow, and prints canonical
 * credentials to stdout:
 *
 *   client_id=...
 *   client_secret=...
 *   { ...full credential JSON... }
 *
 * Same output contract as the per-provider agentic-onboarding scripts this
 * engine replaces. If the engine cannot onboard a provider from its
 * descriptor alone, the descriptor (or the spec) is missing a field — that
 * feedback loop IS the spec process.
 *
 * Usage:
 *   node api-onboard.mjs <descriptor.json|url> [--requirements] [--arg value ...]
 *
 *   --requirements   Print maturity, gates, bootstrap steps, env vars, and
 *                    args, then exit. An agent runs this first to learn what
 *                    a human must provide before it can proceed.
 *
 *   Flow args declared in the descriptor become CLI flags: a flow arg named
 *   "name" is passed as --name "My Agent App".
 *
 * Template language (kept deliberately tiny):
 *   {env.VAR}                    environment variable
 *   {arg.name}                   CLI arg declared in flow.args
 *   {steps.<id>.<json.path.0>}   value from a prior step's JSON response
 *   {a || b}                     first non-empty alternative wins
 *
 * Node.js 18+ stdlib only. No npm install.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import process from "node:process";

/* ------------------------------------------------------------------ loading */

async function loadDescriptor(ref) {
  if (/^https?:\/\//.test(ref)) {
    const res = await fetch(ref, { headers: { accept: "application/json" } });
    if (!res.ok) die(`Could not fetch descriptor: ${res.status} ${ref}`);
    return res.json();
  }
  return JSON.parse(readFileSync(ref, "utf8"));
}

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

/* ---------------------------------------------------------------- templating */

function getPath(obj, path) {
  let cur = obj;
  for (const seg of path.split(".")) {
    if (cur == null) return undefined;
    cur = cur[/^\d+$/.test(seg) ? Number(seg) : seg];
  }
  return cur;
}

function resolveRef(ref, ctx) {
  ref = ref.trim();
  if (ref.startsWith("env.")) return process.env[ref.slice(4)] ?? "";
  if (ref.startsWith("arg.")) return ctx.args[ref.slice(4)] ?? "";
  if (ref.startsWith("steps.")) {
    const [id, ...rest] = ref.slice(6).split(".");
    const v = rest.length ? getPath(ctx.steps[id], rest.join(".")) : ctx.steps[id];
    return v == null ? "" : v;
  }
  // Bare literal inside a fallback chain: {steps.a.id || default-name}
  return ref;
}

function expand(template, ctx) {
  if (typeof template !== "string") return template;
  // A template that is exactly one {...} expression keeps its native type
  const whole = template.match(/^\{([^{}]+)\}$/);
  if (whole) return coalesce(whole[1], ctx);
  return template.replace(/\{([^{}]+)\}/g, (_, expr) => {
    const v = coalesce(expr, ctx);
    return v == null ? "" : String(v);
  });
}

function coalesce(expr, ctx) {
  for (const alt of expr.split("||")) {
    const v = resolveRef(alt, ctx);
    if (v !== "" && v != null) return v;
  }
  return "";
}

function expandBody(node, ctx) {
  if (typeof node === "string") return expand(node, ctx);
  if (Array.isArray(node)) return node.map((n) => expandBody(n, ctx));
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      const ev = expandBody(v, ctx);
      // Omit keys whose value was a pure template that expanded to nothing —
      // this is how optional args stay out of request bodies.
      const pureTemplate = typeof v === "string" && /^\{[^{}]+\}$/.test(v);
      if (pureTemplate && (ev === "" || ev == null)) continue;
      out[k] = ev;
    }
    return out;
  }
  return node;
}

/* -------------------------------------------------------------------- auth */

function findMethod(descriptor, id) {
  const methods = descriptor.authentication?.methods ?? [];
  return methods.find((m) => m.id === id) || null;
}

async function applyAuth(method, headers, ctx) {
  if (!method || method.type === "none") return;
  const envVal = (i = 0) => process.env[method.env?.[i] ?? ""] ?? "";
  switch (method.type) {
    case "bearer-env":
    case "cloud-iam": {
      const token = envVal();
      if (!token) die(`Missing env var ${method.env?.[0]} required by auth method "${method.id}".${method.bootstrap ? `\nBootstrap: ${method.bootstrap}` : ""}`);
      if (method.tokenPrefix && !token.startsWith(method.tokenPrefix)) {
        console.error(`Warning: ${method.env?.[0]} does not start with expected prefix ${method.tokenPrefix}`);
      }
      headers["authorization"] = `Bearer ${token}`;
      return;
    }
    case "basic-env": {
      const user = envVal(0);
      const pass = envVal(1);
      if (!user || !pass) die(`Auth method "${method.id}" needs env vars ${method.env?.join(" + ")}.`);
      headers["authorization"] = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
      return;
    }
    case "header-env": {
      const val = envVal();
      if (!val) die(`Missing env var ${method.env?.[0]} required by auth method "${method.id}".`);
      headers[(method.header || "authorization").toLowerCase()] = val;
      return;
    }
    case "cookie-login": {
      const token = ctx.tokens[method.id] || envVal();
      if (!token) die(`Auth method "${method.id}" has no token; a prior flow step must produce it or ${method.env?.[0]} must be set.`);
      headers["cookie"] = `${method.cookieName || "token"}=${token}`;
      headers["authorization"] = `Bearer ${token}`;
      return;
    }
    case "oauth-pkce-browser": {
      if (!ctx.tokens[method.id]) {
        ctx.tokens[method.id] = await browserPkceToken(ctx.descriptor, method);
      }
      headers["authorization"] = `Bearer ${ctx.tokens[method.id]}`;
      return;
    }
    default:
      die(`Unsupported auth method type: ${method.type}`);
  }
}

/** The SoundCloud move: pop a browser, catch the code on loopback, exchange it. */
async function browserPkceToken(descriptor, method) {
  const mech = (descriptor.registration?.mechanisms ?? []).find((m) => m.type === "browser-oauth");
  if (!mech?.authorizationEndpoint || !mech?.tokenEndpoint || !mech?.publicClientId) {
    die(`Auth method "${method.id}" is oauth-pkce-browser but the descriptor's browser-oauth mechanism is missing authorizationEndpoint/tokenEndpoint/publicClientId.`);
  }
  const redirect = new URL(mech.redirectUri || "http://127.0.0.1:8976/callback");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");

  const authUrl = new URL(mech.authorizationEndpoint);
  authUrl.searchParams.set("client_id", mech.publicClientId);
  authUrl.searchParams.set("redirect_uri", redirect.href);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  if (mech.scopes?.length) authUrl.searchParams.set("scope", mech.scopes.join(" "));

  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, redirect.origin);
      if (url.pathname !== redirect.pathname) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>You can close this window and return to your terminal.</body></html>");
      server.close();
      if (url.searchParams.get("state") !== state) return reject(new Error("OAuth state mismatch."));
      if (url.searchParams.get("error")) return reject(new Error(`OAuth error: ${url.searchParams.get("error")}`));
      resolve(url.searchParams.get("code"));
    });
    server.listen(Number(redirect.port) || 80, redirect.hostname, () => {
      console.error(`Opening browser for ${descriptor.provider?.name} login...`);
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      spawn(opener, [authUrl.href], { stdio: "ignore", detached: true }).unref();
      console.error(`If the browser did not open, visit:\n${authUrl.href}`);
    });
  });

  const res = await fetch(mech.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: mech.publicClientId,
      code,
      redirect_uri: redirect.href,
      code_verifier: verifier,
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) die(`Token exchange failed: ${res.status} ${JSON.stringify(data)}`);
  return data.access_token;
}

/* -------------------------------------------------------------------- flow */

async function runStep(step, ctx) {
  if (step.skipIf) {
    const v = expand(step.skipIf, ctx);
    if (v !== "" && v != null && v !== false) {
      ctx.steps[step.id] = ctx.steps[step.id] ?? {};
      return { skipped: true };
    }
  }
  const headers = { accept: "application/json" };
  for (const [k, v] of Object.entries(step.request.headers ?? {})) headers[k.toLowerCase()] = expand(v, ctx);
  const method = step.auth ? findMethod(ctx.descriptor, step.auth) : null;
  if (step.auth && !method) die(`Step "${step.id}" references unknown auth method "${step.auth}".`);
  await applyAuth(method, headers, ctx);

  const url = expand(step.request.url, ctx);
  let body;
  if (step.request.body !== undefined) {
    const expanded = expandBody(step.request.body, ctx);
    if ((headers["content-type"] || "").includes("application/x-www-form-urlencoded")) {
      body = new URLSearchParams(expanded).toString();
    } else {
      body = JSON.stringify(expanded);
      headers["content-type"] = headers["content-type"] || "application/json";
    }
  }
  console.error(`-> ${step.request.method} ${url}`);
  const res = await fetch(url, { method: step.request.method, headers, ...(body ? { body } : {}) });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { _raw: text }; }
  ctx.steps[step.id] = data;

  // Capture a token for cookie-login auth methods fed by a login step
  if (method?.type === "cookie-login" || step.producesToken) {
    const tok = data?.token ?? data?.access_token ?? data?.portalaccesstoken;
    if (tok && step.producesToken) ctx.tokens[step.producesToken] = tok;
  }

  if (!res.ok) {
    const rule = step.onStatus?.[String(res.status)];
    if (!rule || rule.action === "fail") {
      die(`Step "${step.id}" (${step.request.method} ${url}) failed: ${res.status} ${text.slice(0, 500)}`);
    }
    if (rule.message) console.error(rule.message);
    if (rule.action === "goto") return { goto: rule.step };
    // action === "continue": keep the error body as the step result and move on
  }
  return {};
}

async function runFlow(descriptor, args) {
  const ctx = { descriptor, args, steps: {}, tokens: {} };
  const steps = descriptor.flow?.steps ?? [];
  const byId = Object.fromEntries(steps.map((s) => [s.id, s]));
  let i = 0;
  const ran = new Set();
  while (i < steps.length) {
    const step = steps[i];
    if (ran.has(step.id)) { i++; continue; }
    ran.add(step.id);
    const result = await runStep(step, ctx);
    if (result.goto) {
      const target = byId[result.goto];
      if (!target) die(`Step "${step.id}" onStatus goto references unknown step "${result.goto}".`);
      i = steps.indexOf(target);
      ran.delete(target.id);
      continue;
    }
    i++;
  }

  const outputs = {};
  for (const [key, tmpl] of Object.entries(descriptor.flow?.outputs ?? {})) {
    const v = expand(tmpl, ctx);
    if (v !== "" && v != null) outputs[key] = v;
  }
  return outputs;
}

/* ------------------------------------------------------------- requirements */

function printRequirements(d) {
  const lines = [];
  lines.push(`${d.provider?.name} — programmatic onboarding: ${d.maturity}`);
  if (d.registration?.applicationNoun) lines.push(`They call it: "${d.registration.applicationNoun}"`);
  const prereqs = d.account?.prerequisites ?? [];
  if (d.account?.plans?.length) prereqs.push(...d.account.plans.map((p) => `${p.name} plan — ${p.requiredFor ?? "required"}`));
  if (prereqs.length) lines.push(`\nPrerequisites:`, ...prereqs.map((p) => `  - ${p}`));
  if (d.account?.agentPolicy) lines.push(`\nAgent onboarding policy: ${d.account.agentPolicy}`);
  for (const v of d.verification ?? []) {
    lines.push(`\nVerification gate: ${v.name}${v.blocking ? " (blocking)" : ""}${v.expectedLatency ? ` — ${v.expectedLatency}` : ""}`);
  }
  const methods = d.authentication?.methods ?? [];
  if (methods.length) {
    lines.push(`\nAuthentication methods:`);
    for (const m of methods) {
      lines.push(`  - ${m.id} (${m.type})${m.env?.length ? ` env: ${m.env.join(", ")}` : ""}`);
      if (m.bootstrap) lines.push(`      bootstrap: ${m.bootstrap}`);
    }
  }
  const flowArgs = d.flow?.args ?? [];
  if (flowArgs.length) {
    lines.push(`\nArguments:`);
    for (const a of flowArgs) lines.push(`  --${a.name}${a.required ? " (required)" : ""}${a.description ? `  ${a.description}` : ""}`);
  }
  if (d.gaps?.length) lines.push(`\nStill requires a human:`, ...d.gaps.map((g) => `  - ${g}`));
  console.log(lines.join("\n"));
}

/* --------------------------------------------------------------------- cli */

async function main() {
  const argv = process.argv.slice(2);
  const ref = argv.find((a) => !a.startsWith("--"));
  if (!ref || argv.includes("--help") || argv.includes("-h")) {
    die(`Usage: api-onboard.mjs <descriptor.json|url> [--requirements] [--<arg> <value> ...]`, ref ? 1 : 0);
  }
  const descriptor = await loadDescriptor(ref);
  if (descriptor.aid !== "0.1") console.error(`Warning: descriptor declares aid ${descriptor.aid}; engine speaks 0.1.`);

  if (argv.includes("--requirements")) { printRequirements(descriptor); return; }

  // Collect args declared by the flow from --flag value pairs
  const args = {};
  for (const spec of descriptor.flow?.args ?? []) {
    const idx = argv.indexOf(`--${spec.name}`);
    if (idx >= 0 && argv[idx + 1] !== undefined) args[spec.name] = argv[idx + 1];
    else if (spec.default !== undefined) args[spec.name] = spec.default;
    else if (spec.required) die(`Missing required argument --${spec.name}${spec.description ? ` (${spec.description})` : ""}`);
  }

  if (!descriptor.flow?.steps?.length) {
    die(`This descriptor has no executable flow (maturity: ${descriptor.maturity}). Run with --requirements to see what a human must do.`);
  }

  const outputs = await runFlow(descriptor, args);
  const lines = [];
  for (const key of ["client_id", "client_secret", "api_key", "access_token"]) {
    if (outputs[key]) lines.push(`${key}=${outputs[key]}`);
  }
  lines.push("", JSON.stringify(outputs, null, 2), "");
  process.stdout.write(lines.join("\n"));
}

main().catch((e) => die(`Error: ${e?.message || e}`));
