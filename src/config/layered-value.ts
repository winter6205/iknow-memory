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
