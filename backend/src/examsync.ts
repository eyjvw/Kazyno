// Sync automatique des exams du campus depuis l'API 42 — plus de création
// manuelle. Au boot puis toutes les heures : GET /v2/campus/:id/exams
// filtrés sur le futur, upsert dans `exams` (clé = ft_id).
import { sql } from "./db";
import { getAppToken, examToRank, type FtExamLike } from "./cursussync";

const CAMPUS_ID = Number((process.env.ALLOWED_CAMPUS_IDS ?? "62").split(",")[0]) || 62;
const SYNC_INTERVAL = 60 * 60 * 1000; // 1 h

interface FtCampusExam extends FtExamLike
{
	id: number;
	name: string;
	begin_at: string;
}

async function syncExams(): Promise<void>
{
	try
	{
		const token = await getAppToken();
		if (!token) return;
		const res = await fetch(
			`https://api.intra.42.fr/v2/campus/${CAMPUS_ID}/exams?filter%5Bfuture%5D=true&page%5Bsize%5D=100`,
			{ headers: { Authorization: `Bearer ${token}` } },
		);
		if (!res.ok)
		{
			console.error(`[exam-sync] HTTP ${res.status}`);
			return;
		}
		const ftExams = (await res.json()) as FtCampusExam[];

		for (const e of ftExams)
		{
			const rank = examToRank(e);                       // 0 = piscine, 2-6, null = ouvert
			const isFinal = /final/i.test(e.name)
				|| (e.projects ?? []).some((p) => /final/i.test(p.name ?? ""));
			await sql`
				INSERT INTO exams (ft_id, label, exam_date, is_final, rank)
				VALUES (${e.id}, ${e.name.slice(0, 80)}, ${e.begin_at}, ${isFinal}, ${rank})
				ON CONFLICT (ft_id) DO UPDATE SET
					label     = EXCLUDED.label,
					exam_date = EXCLUDED.exam_date,
					is_final  = EXCLUDED.is_final,
					rank      = EXCLUDED.rank
			`;
		}
		if (ftExams.length) console.log(`[exam-sync] ${ftExams.length} exam(s) campus ${CAMPUS_ID} synchronisés`);
	}
	catch (e)
	{
		console.error("[exam-sync]", e);
	}
}

export function initExamSync(): void
{
	void syncExams(); // premier passage sans bloquer le boot
	setInterval(() => void syncExams(), SYNC_INTERVAL);
}
