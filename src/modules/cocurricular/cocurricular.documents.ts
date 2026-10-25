import { z } from 'zod';
import { db } from '../../core/db';
import { badRequest, notFound } from '../../core/errors';
import { isoOf } from '../attendance/attendance.settings';
import { defineDocument } from '../documents/documents.registry';
import { houseList, masterNames, need, studentInfo } from './cocurricular.common';

/**
 * Competition certificates: one page per student (a team gives a page to each of its students),
 * "Certificate of Merit" for a place, "Certificate of Participation" otherwise. Schools reword or
 * restyle it in Setup → Document Templates.
 */

const ORD = (n: number) => (n === 1 ? 'First' : n === 2 ? 'Second' : n === 3 ? 'Third' : `${n}th`);

const pagesOf = async (params: Record<string, string>) => {
    const id = z.uuid().safeParse(params.competition);
    if (!id.success) throw badRequest('Choose the competition');
    const c = await db.competition.findFirst({ where: { id: id.data }, include: { entries: { orderBy: [{ position: { sort: 'asc', nulls: 'last' } }] } } });
    if (!c) throw notFound('Competition not found');
    // which: merit (places only) | participation (no place) | all; or one entry.
    const which = params.which ?? 'all';
    const entries = c.entries.filter((e) => (params.entry ? e.id === params.entry : which === 'merit' ? !!e.position : which === 'participation' ? !e.position : true));
    const [info, m, houses] = await Promise.all([studentInfo(entries.flatMap((e) => e.studentIds), c.academicYearId), masterNames([c.levelId, c.categoryId]), houseList(true)]);
    const pages = entries.flatMap((e) =>
        e.studentIds.map((s) => {
            const st = info.get(s);
            return {
                merit: !!e.position,
                title: e.position ? 'Certificate of Merit' : 'Certificate of Participation',
                name: st?.name ?? '',
                section: st?.section ?? '',
                house: houses.find((h) => h.id === (e.houseId ?? st?.houseId))?.name ?? '',
                position: e.position ? ORD(e.position) : '',
                award: e.award ?? '',
                team: e.teamName ?? '',
                competition: c.name,
                level: m.get(c.levelId ?? '') ?? '',
                category: m.get(c.categoryId ?? '') ?? '',
                date: new Date(`${isoOf(c.date)}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }),
                venue: c.venue ?? '',
            };
        })
    );
    if (!pages.length) throw badRequest('No students to print certificates for (add entries with students first)');
    return { c, pages };
};

defineDocument({
    key: 'competition_certificate',
    label: 'Competition certificate',
    description: 'Merit (1st / 2nd / 3rd, awards) and participation certificates for a competition, one page per student.',
    fields: [
        { key: 'title', label: '“Certificate of Merit” or “Certificate of Participation”' },
        { key: 'merit', label: 'True for a place (use {{#if merit}}…{{/if}})' },
        { key: 'name / section / house', label: 'The student' },
        { key: 'position / award / team', label: 'The result (“First”, “Best speaker”, the team’s name)' },
        { key: 'competition / level / category / date / venue', label: 'The competition' },
    ],
    html: `<div class="frame"><div class="inner">
{{#if school.logo}}<img class="logo" src="{{school.logo}}" alt="">{{/if}}
<h1 class="school">{{school.name}}</h1>
<p class="addr">{{school.address}}</p>
<h2 class="title">{{title}}</h2>
<p class="line">This is to certify that</p>
<p class="name">{{name}}</p>
<p class="line">of class <b>{{section}}</b>{{#if house}}, <b>{{house}}</b> house,{{/if}}
{{#if merit}}secured the <b>{{position}}</b> position{{#if award}} ({{award}}){{/if}}{{else}}participated{{#if award}} and was awarded <b>{{award}}</b>{{/if}}{{/if}}
in <b>{{competition}}</b>{{#if team}} as a member of <b>{{team}}</b>{{/if}}{{#if level}} ({{level}}){{/if}}
held on <b>{{date}}</b>{{#if venue}} at {{venue}}{{/if}}.</p>
<p class="wish">{{#if merit}}Congratulations on this achievement!{{else}}We appreciate the enthusiasm and effort.{{/if}}</p>
<div class="signs"><div>In-charge</div><div>Principal</div></div>
</div></div>`,
    css: `body { font-family: Georgia, 'Times New Roman', serif; color: #1f2937; }
.frame { border: 10px double #1A365D; padding: 8px; height: 175mm; box-sizing: border-box; }
.inner { border: 2px solid #C9A227; height: 100%; box-sizing: border-box; padding: 18px 40px; text-align: center; position: relative; }
.logo { height: 60px; }
.school { font-size: 26px; margin: 6px 0 0; color: #1A365D; letter-spacing: 1px; }
.addr { margin: 2px 0 10px; font-size: 12px; color: #555; }
.title { font-size: 30px; margin: 10px 0 14px; color: #8B6B10; font-style: italic; }
.line { font-size: 15px; line-height: 1.7; margin: 4px 0; }
.name { font-size: 30px; font-weight: bold; margin: 6px 0; color: #1A365D; border-bottom: 1px solid #C9A227; display: inline-block; padding: 0 30px 2px; }
.wish { margin-top: 14px; font-size: 14px; }
.signs { position: absolute; left: 60px; right: 60px; bottom: 26px; display: flex; justify-content: space-between; font-size: 13px; }
.signs div { border-top: 1px solid #333; padding-top: 4px; width: 180px; }`,
    paper: { size: 'A4', orientation: 'landscape', margin: 10, copies: ['Certificate'] },
    sample: async () => ({
        data: { merit: true, title: 'Certificate of Merit', name: 'Shubham Nautiyal', section: 'VII-B', house: 'Red', position: 'First', award: 'Best speaker', team: '', competition: 'Inter-house Debate', level: 'Inter-house', category: 'Literary', date: '20 October 2026', venue: 'School auditorium' },
        filename: 'certificate-sample.pdf',
    }),
    load: async (params, userId) => {
        await need(userId, ['competition.manage']);
        const { c, pages } = await pagesOf(params);
        return { data: pages[0], many: pages, filename: `certificates-${c.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.pdf` };
    },
});
