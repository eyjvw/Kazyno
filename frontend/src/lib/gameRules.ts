// Static rules content for each game's /games/rules/<slug> page.

export interface GameRule
{
	slug: string;
	icon: string;
	title: string;
	tagline: string;
	sections: { heading: string; body: string }[];
	table?: { headers: string[]; rows: string[][] };
	edge: string;
}

export const gameRules: GameRule[] = [
	{
		slug: "coinflip",
		icon: "🪙",
		title: "Coinflip",
		tagline: "Pile ou face, 50/50.",
		sections: [
			{ heading: "Comment jouer", body: "Choisis pile ou face et mise tes points. Une pièce provably fair tranche : bon appel, tu doubles quasiment ta mise." },
			{ heading: "Gain", body: "Victoire : mise × 1.98. La légère décote (au lieu de ×2 pile) donne l'avantage maison." },
		],
		edge: "House edge : 1%",
	},
	{
		slug: "dice",
		icon: "🎲",
		title: "Dés",
		tagline: "Choisis ta cible, joue en dessous ou au-dessus.",
		sections: [
			{ heading: "Comment jouer", body: "Un nombre entre 0.00 et 100.00 est tiré. Fixe une cible entre 2 et 98, et parie qu'il sortira en dessous (\"under\") ou au-dessus (\"over\")." },
			{ heading: "Chance de gagner", body: "Under : chance = cible. Over : chance = 100 − cible. Plus la cible est serrée, plus le multiplicateur grimpe." },
			{ heading: "Gain", body: "Multiplicateur = (100 / chance) × 0.99." },
		],
		edge: "House edge : 1%",
	},
	{
		slug: "limbo",
		icon: "🚀",
		title: "Limbo",
		tagline: "Vise un multiplicateur, jusqu'où ça grimpe ?",
		sections: [
			{ heading: "Comment jouer", body: "Fixe un multiplicateur cible entre 1.01× et 1 000 000×. Un résultat aléatoire est tiré ; si le résultat dépasse ta cible, tu gagnes." },
			{ heading: "Gain", body: "Victoire : mise × cible. Plus la cible est haute, plus la chance de l'atteindre est faible." },
		],
		edge: "House edge : 1%",
	},
	{
		slug: "plinko",
		icon: "⚪",
		title: "Plinko",
		tagline: "Lâche la bille, regarde-la rebondir sur 8 rangées.",
		sections: [
			{ heading: "Comment jouer", body: "La bille traverse 8 rangées de picots, direction gauche/droite 50/50 à chaque rangée, puis tombe dans l'un des 9 bacs en bas." },
			{ heading: "Gain", body: "Chaque bac a son propre multiplicateur — les bacs centraux paient peu, les extrêmes paient gros." },
		],
		table: {
			headers: ["Bac", "1", "2", "3", "4", "5 (centre)", "6", "7", "8", "9"],
			rows: [["Multi", "5.6×", "2.1×", "1.1×", "1×", "0.5×", "1×", "1.1×", "2.1×", "5.6×"]],
		},
		edge: "Distribution symétrique, retour attendu ≈ 99%",
	},
	{
		slug: "slots",
		icon: "🎰",
		title: "Machine à sous",
		tagline: "3 rouleaux, alignement des symboles.",
		sections: [
			{ heading: "Comment jouer", body: "Lance les 3 rouleaux. Aligner 3 symboles identiques paie selon leur rareté ; 2 symboles rares peuvent aussi payer un peu." },
			{ heading: "Jackpot", body: "Trois 7️⃣ déclenchent en plus le jackpot progressif alimenté par toutes les mises du site." },
		],
		table: {
			headers: ["Symbole", "🍒", "🍋", "🔔", "⭐", "💎", "7️⃣"],
			rows: [["3 alignés", "8×", "12×", "20×", "40×", "90×", "250× + jackpot"]],
		},
		edge: "Symboles pondérés par rareté (7️⃣ le plus rare)",
	},
	{
		slug: "wheel",
		icon: "🎡",
		title: "Roue",
		tagline: "50 segments, fais tourner la roue.",
		sections: [
			{ heading: "Comment jouer", body: "La roue a 50 segments. La plupart des segments pairs sont perdants (0×), les segments impairs paient un multiplicateur variable." },
		],
		table: {
			headers: ["Multiplicateur", "1.5×", "2×", "3×", "5.5×"],
			rows: [["Segments", "16", "7", "2", "1"]],
		},
		edge: "House edge ≈ 1%",
	},
	{
		slug: "roulette",
		icon: "🔴",
		title: "Roulette",
		tagline: "Roulette européenne, simple zéro.",
		sections: [
			{ heading: "Comment jouer", body: "Roue européenne 0–36. Mise sur un numéro plein, une couleur, pair/impair, haut/bas, une douzaine ou une colonne." },
		],
		table: {
			headers: ["Mise", "Numéro plein", "Rouge/Noir · Pair/Impair · Manque/Passe", "Douzaine · Colonne"],
			rows: [["Paie", "36×", "2×", "3×"]],
		},
		edge: "House edge : 1% (simple zéro)",
	},
	{
		slug: "keno",
		icon: "🔢",
		title: "Keno",
		tagline: "Choisis tes numéros, 10 sont tirés parmi 40.",
		sections: [
			{ heading: "Comment jouer", body: "Sélectionne 1 à 10 numéros parmi 40. 10 numéros sont tirés au sort. Ton gain dépend du nombre de tes numéros qui sortent, selon une grille de paiement liée au nombre de numéros choisis." },
			{ heading: "Exemple — 10 numéros joués", body: "0 à 2 bons numéros : rien. 5 bons : 4.5×. 8 bons : 50×. 10/10 : 100× (le max)." },
		],
		edge: "Paiement max 100×, grille complète affichée en jeu",
	},
	{
		slug: "crash",
		icon: "📈",
		title: "Crash",
		tagline: "Le multiplicateur grimpe, encaisse avant le crash.",
		sections: [
			{ heading: "Comment jouer", body: "Une fusée décolle, le multiplicateur augmente en continu. Encaisse quand tu veux — mais si le crash survient avant, tu perds ta mise." },
			{ heading: "Le crash", body: "3% de chance de crasher instantanément à 1.00×. Sinon le point de crash est tiré aléatoirement, plafonné à 1000×." },
			{ heading: "Gain", body: "Encaissé à temps : mise × multiplicateur au moment du cashout." },
		],
		edge: "House edge : 1%, cap 1000×",
	},
	{
		slug: "mines",
		icon: "💣",
		title: "Mines",
		tagline: "Grille 5×5, évite les mines.",
		sections: [
			{ heading: "Comment jouer", body: "Choisis le nombre de mines (1 à 24) sur une grille de 25 cases, puis révèle des cases une à une. Chaque case sûre augmente le multiplicateur." },
			{ heading: "Cashout", body: "Encaisse à tout moment. Toucher une mine = mise perdue intégralement." },
			{ heading: "Gain", body: "Multiplicateur croît selon le nombre de cases sûres révélées et le nombre de mines choisi — plus de mines = progression plus rapide mais plus risquée." },
		],
		edge: "House edge : 3%",
	},
	{
		slug: "hilo",
		icon: "🃏",
		title: "Hi-Lo",
		tagline: "Plus haut ou plus bas que la carte précédente ?",
		sections: [
			{ heading: "Comment jouer", body: "Une carte est révélée (2 à As). Parie que la suivante sera plus haute ou plus basse. Bonne réponse : le multiplicateur grimpe et tu peux continuer ou encaisser." },
			{ heading: "Égalité", body: "Une égalité de valeur compte comme une perte." },
			{ heading: "Gain", body: "Chaque bonne prédiction multiplie ton multiplicateur cumulé par 0.99 / probabilité de la bonne réponse." },
		],
		edge: "House edge : 1%",
	},
	{
		slug: "tower",
		icon: "🗼",
		title: "Tower",
		tagline: "8 étages, 3 cases, 1 piège par étage.",
		sections: [
			{ heading: "Comment jouer", body: "Choisis une case parmi 3 à chaque étage (8 étages au total). Une case sur les 3 est piégée. Case sûre → tu montes d'un étage et le multiplicateur augmente." },
			{ heading: "Cashout", body: "Encaisse à tout moment entre les étages. Tomber sur un piège = mise perdue." },
		],
		edge: "House edge : 3% — chance de survie 2/3 par étage",
	},
	{
		slug: "blackjack",
		icon: "🂡",
		title: "Blackjack",
		tagline: "21 sans dépasser, bats le croupier.",
		sections: [
			{ heading: "Comment jouer", body: "Approche-toi de 21 sans le dépasser. Le croupier tire tant que sa main est inférieure à 17, et s'arrête dès qu'il atteint 17." },
			{ heading: "Blackjack naturel", body: "As + carte de 10 dès la donne = blackjack, payé 3:2 (mise ×1.5 de gain, plus la mise rendue)." },
			{ heading: "Égalité", body: "Un push (égalité, y compris blackjack contre blackjack) rend simplement la mise." },
			{ heading: "Actions", body: "Tirer, rester, doubler — selon ta main. Table multijoueur avec bots possibles, invite tes amis via notification." },
		],
		edge: "Gain standard 1:1, blackjack 3:2",
	},
	{
		slug: "poker",
		icon: "♠️",
		title: "Poker",
		tagline: "Texas Hold'em, blinds 10/20.",
		sections: [
			{ heading: "Comment jouer", body: "Texas Hold'em classique : 2 cartes privées, 5 cartes communes (flop/turn/river), meilleure main de 5 cartes gagne le pot." },
			{ heading: "Blinds", body: "Petite blind : 10 pts. Grosse blind : 20 pts. Mise minimum pour relancer : 20 pts (la grosse blind)." },
			{ heading: "Table", body: "Rooms multijoueurs en temps réel — crée ou rejoins une table depuis le lobby, joueurs sous la grosse blind sont exclus avant les blinds." },
		],
		edge: "Pas d'avantage maison — poker joueur contre joueur",
	},
];

export function getGameRule(slug: string): GameRule | undefined
{
	return gameRules.find((g) => g.slug === slug);
}
