# Modo: oferta — Evaluación Completa A-F

Cuando el candidato pega una oferta (texto o URL), entregar SIEMPRE los 6 bloques:

## Paso 0 — Detección de Arquetipo

Clasificar la oferta en uno de los 6 arquetipos (ver `_shared.md`). Si es híbrido, indicar los 2 más cercanos. Esto determina:
- Qué proof points priorizar en bloque B
- Cómo reescribir el summary en bloque E
- Qué historias STAR preparar en bloque F

## Bloque A — Resumen del Rol

Tabla con:
- Arquetipo detectado
- Domain (platform/agentic/LLMOps/ML/enterprise)
- Function (build/consult/manage/deploy)
- Seniority
- Remote (full/hybrid/onsite)
- Team size (si se menciona)
- TL;DR en 1 frase

## Bloque B — Match with CV (Scout-flavored)

Read `cv.md`. This block plays the role of **The Scout**: a forensic talent analyst whose only
job is to score the CV against this JD and tell the unfiltered truth. **Be ruthless. Do not
grade on a curve.** Quote specific lines from `cv.md` when calling out gaps. Distinguish
"missing entirely" vs "present but weak." Never invent skills or credentials. Never grade on
potential — grade on what is on the page.

Output, in this order:

### B.1 — Match Table

Map each JD requirement to the exact CV line that supports it. Columns:
`Requirement | CV Evidence (quoted) | Strength`. Strength MUST be one of:
`✅ Strong`, `✅ Moderate`, `⚠️ Gap`, `⚠️ Mitigable`.

**Archetype framing for evidence selection:**
- FDE → prioritize delivery speed + client-facing proof
- SA → system design + integrations
- PM → product discovery + metrics
- LLMOps → evals, observability, pipelines
- Agentic → multi-agent, HITL, orchestration
- Transformation → change management, adoption, scaling

### B.2 — Fit Sub-Scores (out of 25 each, sum becomes block input)

| Dimension | Score / 25 | Reasoning |
|---|---|---|
| Keyword Match | X / 25 | Density + placement of JD critical terms in CV |
| Skills Alignment | X / 25 | Tools, frameworks, certifications claimed vs required |
| Experience Relevance | X / 25 | Domain + role-type adjacency |
| Seniority Signal | X / 25 | Scope, ownership, level signals in CV vs JD |

### B.3 — Keyword Gap (top 10)

Top 10 phrases that appear in the JD but are missing or buried in the CV.

| JD Phrase | Count in JD | Closest CV Reference (or "none") | Impact |
|---|---|---|---|
| ... | N | quoted line or "none" | HIGH / MED / LOW |

This list is the **Recruiter's input** in the PDF step — every HIGH/MED keyword must be
woven into the rewritten resume.

### B.4 — Skills Gap (top 5)

Top 5 skills/tools/certifications the JD requires that the CV does not claim. For each: is
it credibly addable from adjacent experience, or an honest gap?

### B.5 — Positioning Gaps (top 3)

The 3 biggest disconnects between the story the CV tells and the story this role wants.
Quote the offending CV lines.

### B.6 — Gap Mitigation

For each ⚠️ row above:
1. Hard blocker or nice-to-have?
2. Adjacent experience to lean on?
3. Portfolio project that could cover it?
4. Concrete mitigation (cover letter sentence, side project, framing).

### B.7 — Ruthless Verdict (one paragraph)

If the CV is wrong for this role, say it. Underqualified, say it. Overqualified, say it.

## Bloque C — Nivel y Estrategia

1. **Nivel detectado** en el JD vs **nivel natural del candidato para ese arquetipo**
2. **Plan "vender senior sin mentir"**: frases específicas adaptadas al arquetipo, logros concretos a destacar, cómo posicionar la experiencia de founder como ventaja
3. **Plan "si me downlevelan"**: aceptar si comp es justa, negociar review a 6 meses, criterios de promoción claros

## Bloque D — Comp y Demanda

Usar WebSearch para:
- Salarios actuales del rol (Glassdoor, Levels.fyi, Blind)
- Reputación de compensación de la empresa
- Tendencia de demanda del rol

Tabla con datos y fuentes citadas. Si no hay datos, decirlo en vez de inventar.

## Bloque E — Plan de Personalización

| # | Sección | Estado actual | Cambio propuesto | Por qué |
|---|---------|---------------|------------------|---------|
| 1 | Summary | ... | ... | ... |
| ... | ... | ... | ... | ... |

Top 5 cambios al CV + Top 5 cambios a LinkedIn para maximizar match.

## Bloque F — Plan de Entrevistas

6-10 historias STAR+R mapeadas a requisitos del JD (STAR + **Reflection**):

| # | Requisito del JD | Historia STAR+R | S | T | A | R | Reflection |
|---|-----------------|-----------------|---|---|---|---|------------|

The **Reflection** column captures what was learned or what would be done differently. This signals seniority — junior candidates describe what happened, senior candidates extract lessons.

**Story Bank:** If `interview-prep/story-bank.md` exists, check if any of these stories are already there. If not, append new ones. Over time this builds a reusable bank of 5-10 master stories that can be adapted to any interview question.

**Seleccionadas y enmarcadas según el arquetipo:**
- FDE → enfatizar velocidad de entrega y client-facing
- SA → enfatizar decisiones de arquitectura
- PM → enfatizar discovery y trade-offs
- LLMOps → enfatizar métricas, evals, production hardening
- Agentic → enfatizar orchestration, error handling, HITL
- Transformation → enfatizar adopción, cambio organizacional

Incluir también:
- 1 case study recomendado (cuál de sus proyectos presentar y cómo)
- Preguntas red-flag y cómo responderlas (ej: "¿por qué vendiste tu empresa?", "¿tienes equipo de reports?")

---

## Post-evaluación

**SIEMPRE** después de generar los bloques A-F:

### 1. Guardar report .md

Guardar evaluación completa en `reports/{###}-{company-slug}-{YYYY-MM-DD}.md`.

- `{###}` = siguiente número secuencial (3 dígitos, zero-padded)
- `{company-slug}` = nombre de empresa en lowercase, sin espacios (usar guiones)
- `{YYYY-MM-DD}` = fecha actual

**Formato del report:**

```markdown
# Evaluación: {Empresa} — {Rol}

**Fecha:** {YYYY-MM-DD}
**Arquetipo:** {detectado}
**Score:** {X/5}
**PDF:** {ruta o pendiente}

---

## A) Resumen del Rol
(contenido completo del bloque A)

## B) Match con CV
(contenido completo del bloque B)

## C) Nivel y Estrategia
(contenido completo del bloque C)

## D) Comp y Demanda
(contenido completo del bloque D)

## E) Plan de Personalización
(contenido completo del bloque E)

## F) Plan de Entrevistas
(contenido completo del bloque F)

## G) Draft Application Answers
(solo si score >= 4.5 — borradores de respuestas para el formulario de aplicación)

---

## Keywords extraídas
(lista de 15-20 keywords del JD para ATS optimization)
```

### 2. Registrar en tracker

**SIEMPRE** registrar en `data/applications.md`:
- Siguiente número secuencial
- Fecha actual
- Empresa
- Rol
- Score: promedio de match (1-5)
- Estado: `Evaluada`
- PDF: ❌ (o ✅ si auto-pipeline generó PDF)
- Report: link relativo al report .md (ej: `[001](reports/001-company-2026-01-01.md)`)

**Formato del tracker:**

```markdown
| # | Fecha | Empresa | Rol | Score | Estado | PDF | Report |
```
