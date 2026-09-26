function readService(ctx, key) {
  const get = ctx?.get;
  if (typeof get !== "function") return void 0;
  return get.call(ctx, key);
}
function settingsOf(ctx) {
  return readService(ctx, "settings");
}
function hasLegacyNamespaceRegistration(settings) {
  return typeof settings?.register === "function";
}
function ownEntryId(ctx) {
  const fiber = ctx.fiber;
  const id = fiber?.entry?.options?.id;
  return typeof id === "string" && id.length > 0 ? id : void 0;
}
function settingsNamespaceFor(ctx, legacyNs) {
  if (hasLegacyNamespaceRegistration(settingsOf(ctx))) return legacyNs;
  return ownEntryId(ctx) ?? legacyNs;
}
function suppressAutoSettingsPage(ctx) {
  const settings = settingsOf(ctx);
  if (typeof settings?.configure !== "function") return;
  const configure = settings.configure.bind(settings);
  const owner = ctx.fiber;
  const effect = ctx.effect;
  const register = () => configure({ auto: false }, owner);
  try {
    if (typeof effect === "function") effect.call(ctx, register, "jet-hub: settings presentation");
    else register();
  } catch {
  }
}
export {
  hasLegacyNamespaceRegistration,
  ownEntryId,
  readService,
  settingsNamespaceFor,
  settingsOf,
  suppressAutoSettingsPage
};
