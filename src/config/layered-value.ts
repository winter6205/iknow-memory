export type ConfigLayer = "env" | "setting" | "home-env-file" | "default";

export type EnvBag = Readonly<Record<string, string | undefined>>;

export interface LayerSources {
  env: EnvBag;
  setting: Readonly<Record<string, string>>;
  homeEnv: Readonly<Record<string, string>>;
}

export interface LayeredValue {
  value: string | undefined;
  layer: ConfigLayer;
}

function nonBlank(bag: EnvBag, key: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(bag, key)) return undefined;
  const raw = bag[key];
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw;
}

function owned(bag: EnvBag, key: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(bag, key)) return undefined;
  const raw = bag[key];
  return raw === undefined ? "" : raw;
}

/**
 * First non-blank layer wins. A blank value does not hide a later non-blank
 * layer. When every present layer is blank, the blank is returned so a
 * numeric parser can reject `KEY=` instead of taking the default.
 */
export function resolveRawLayeredValue(
  key: string,
  sources: LayerSources
): string | undefined {
  const layers = [sources.env, sources.setting, sources.homeEnv];
  let blank: string | undefined;
  for (const bag of layers) {
    const raw = owned(bag, key);
    if (raw === undefined) continue;
    if (raw.trim() !== "") return raw;
    if (blank === undefined) blank = raw;
  }
  return blank;
}

export function resolveLayeredValue(
  key: string,
  sources: LayerSources
): LayeredValue {
  const fromEnv = nonBlank(sources.env, key);
  if (fromEnv !== undefined) return { value: fromEnv, layer: "env" };
  const fromSetting = nonBlank(sources.setting, key);
  if (fromSetting !== undefined)
    return { value: fromSetting, layer: "setting" };
  const fromHome = nonBlank(sources.homeEnv, key);
  if (fromHome !== undefined)
    return { value: fromHome, layer: "home-env-file" };
  return { value: undefined, layer: "default" };
}
