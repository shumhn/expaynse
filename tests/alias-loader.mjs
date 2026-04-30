import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const projectRoot = path.resolve(process.cwd());
const nextServerShimPath = path.resolve(
  projectRoot,
  "tests/next-server-shim.mjs",
);

function resolveTsPath(relativePath) {
  const basePath = path.resolve(projectRoot, relativePath);
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.mjs`,
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.tsx"),
    path.join(basePath, "index.js"),
    path.join(basePath, "index.mjs"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return basePath;
}

export async function resolve(specifier, context, defaultResolve) {
  if (specifier === "next/server" || specifier === "next/server.js") {
    return {
      url: pathToFileURL(nextServerShimPath).href,
      shortCircuit: true,
    };
  }

  if (specifier.startsWith("@/")) {
    const relativePath = specifier.slice(2);
    const resolvedPath = resolveTsPath(relativePath);

    return {
      url: pathToFileURL(resolvedPath).href,
      shortCircuit: true,
    };
  }

  return defaultResolve(specifier, context, defaultResolve);
}
