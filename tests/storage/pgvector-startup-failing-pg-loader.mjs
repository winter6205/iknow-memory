const fakePgSource = [
  "export class Pool {",
  "  constructor(config) {",
  "    throw new Error('fake pg constructor failed for ' + config.connectionString);",
  "  }",
  "}",
].join("\n");
const fakePgUrl = `data:text/javascript,${encodeURIComponent(fakePgSource)}`;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "pg") {
    return { url: fakePgUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context, nextResolve);
}

export async function load(url, context, nextLoad) {
  if (url === fakePgUrl) {
    return {
      format: "module",
      source: fakePgSource,
      shortCircuit: true,
    };
  }
  return nextLoad(url, context, nextLoad);
}
