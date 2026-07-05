// Minimal i18n: flat key -> {fr, en} dictionary + t() lookup.
// Locale is cached in localStorage for an instant first paint, then
// reconciled with the account's saved locale once loadMe() resolves.

export type Locale = "fr" | "en";

const STORAGE_KEY = "locale";

const dict = {
	"nav.games":       { fr: "Jeux",         en: "Games" },
	"nav.leaderboard": { fr: "Classement",   en: "Leaderboard" },
	"nav.bets":        { fr: "Paris",        en: "Bets" },
	"nav.giveaways":   { fr: "Giveaways",    en: "Giveaways" },
	"nav.shop":        { fr: "Boutique",     en: "Shop" },
	"nav.admin":       { fr: "Admin",        en: "Admin" },
	"nav.profile":     { fr: "Mon profil",   en: "My profile" },
	"nav.settings":    { fr: "Réglages",     en: "Settings" },
	"nav.logout":      { fr: "Se déconnecter", en: "Log out" },
	"nav.delete":      { fr: "Supprimer mon compte", en: "Delete my account" },
	"nav.pts":         { fr: "pts", en: "pts" },

	"footer.fair":    { fr: "Fair-play",       en: "Fair play" },
	"footer.privacy": { fr: "Confidentialité", en: "Privacy" },
	"footer.terms":   { fr: "CGU",             en: "Terms" },

	"home.tag":      { fr: "42 Le Havre", en: "42 Le Havre" },
	"home.title":    { fr: "Kazyno", en: "Kazyno" },
	"home.lede":     {
		fr: "Le casino de l'intra 42. Tu mises des points, pas des euros : connecte-toi avec ton compte 42, repars avec {{points}}, et tente ta chance au blackjack, dice, plinko et plus.",
		en: "The 42 intra casino. You bet points, not euros: log in with your 42 account, start with {{points}}, and try your luck at blackjack, dice, plinko and more.",
	},
	"home.cta": { fr: "Se connecter avec 42 →", en: "Log in with 42 →" },

	"profile.back":         { fr: "← Retour",           en: "← Back" },
	"profile.loading":      { fr: "Chargement…",        en: "Loading…" },
	"profile.not_found":    { fr: "Joueur introuvable.", en: "Player not found." },
	"profile.not_logged":   { fr: "Non connecté.",       en: "Not logged in." },
	"profile.self_tag":     { fr: "C'est toi",           en: "That's you" },
	"profile.remove_friend":{ fr: "Retirer des amis",    en: "Remove friend" },
	"profile.request_sent": { fr: "Demande envoyée",     en: "Request sent" },
	"profile.accept":       { fr: "Accepter la demande", en: "Accept request" },
	"profile.add_friend":   { fr: "Ajouter en ami",      en: "Add friend" },
	"profile.online":       { fr: "en ligne",            en: "online" },
	"profile.offline":      { fr: "hors ligne",          en: "offline" },
	"profile.balance":      { fr: "Solde",               en: "Balance" },
	"profile.rank":         { fr: "Rang",                en: "Rank" },
	"profile.member_since": { fr: "Membre depuis",       en: "Member since" },
	"profile.achievements": { fr: "Succès",              en: "Achievements" },
	"profile.no_achievements": { fr: "Aucun succès encore.", en: "No achievements yet." },
	"profile.my_games":     { fr: "Mes parties",         en: "My games" },
	"profile.no_games":     { fr: "Aucune partie enregistrée.", en: "No games recorded yet." },
	"profile.games_profit": { fr: "sur {{n}} parties",   en: "over {{n}} games" },
	"profile.fair_title":   { fr: "Provably fair 🔒",    en: "Provably fair 🔒" },
	"profile.fair_help":    { fr: "Comment ça marche ?", en: "How does it work?" },
	"profile.settings_link":{ fr: "Réglages du compte",  en: "Account settings" },
	"profile.title_section":{ fr: "Titre affiché",       en: "Displayed title" },
	"profile.no_title":     { fr: "Aucun titre",         en: "No title" },

	"settings.title":       { fr: "Réglages",            en: "Settings" },
	"settings.back":        { fr: "← Retour au profil",  en: "← Back to profile" },
	"settings.lang_section":{ fr: "Langue",              en: "Language" },
	"settings.lang_fr":     { fr: "Français",            en: "French" },
	"settings.lang_en":     { fr: "Anglais",             en: "English" },

	"settings.presence_section": { fr: "Statut en ligne", en: "Online status" },
	"settings.presence_help":    {
		fr: "Si tu masques ton statut, tu ne verras pas non plus celui des autres.",
		en: "If you hide your status, you won't see anyone else's either.",
	},
	"settings.presence_toggle":  { fr: "Afficher mon statut en ligne", en: "Show my online status" },

	"settings.notif_section": { fr: "Notifications", en: "Notifications" },
	"settings.notif_rain":     { fr: "Pluie de points",        en: "Point rain" },
	"settings.notif_giveaway": { fr: "Giveaways",              en: "Giveaways" },
	"settings.notif_social":   { fr: "Amis & duels",           en: "Friends & duels" },
	"settings.notif_exam":     { fr: "Paris d'exam",           en: "Exam bets" },
	"settings.notif_admin":    { fr: "Messages admin",         en: "Admin messages" },
} as const satisfies Record<string, Record<Locale, string>>;

export type TKey = keyof typeof dict;

let current: Locale = "fr";
try
{
	const saved = localStorage.getItem(STORAGE_KEY);
	if (saved === "fr" || saved === "en") current = saved;
} catch {}

type Listener = (locale: Locale) => void;
const listeners = new Set<Listener>();

export function getLocale(): Locale
{
	return current;
}

/** Reconcile with the account's saved locale (does not re-persist to the server). */
export function syncLocale(locale: string | null | undefined)
{
	if (locale !== "fr" && locale !== "en") return;
	if (locale === current) return;
	current = locale;
	try { localStorage.setItem(STORAGE_KEY, locale); } catch {}
	listeners.forEach((fn) => fn(current));
}

/** User-initiated change: updates locally, persists to the account, notifies listeners. */
export async function setLocale(locale: Locale)
{
	current = locale;
	try { localStorage.setItem(STORAGE_KEY, locale); } catch {}
	listeners.forEach((fn) => fn(current));
	try
	{
		await fetch("/api/auth/locale", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ locale }),
		});
	} catch {}
}

/** Re-render callback fired whenever the locale changes. */
export function onLocaleChange(fn: Listener)
{
	listeners.add(fn);
	return () => listeners.delete(fn);
}

export function t(key: TKey, vars?: Record<string, string | number>): string
{
	const entry = dict[key];
	let text: string = entry ? entry[current] : key;
	if (vars) for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{{${k}}}`, String(v));
	return text;
}
