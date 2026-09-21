/**
 * Character card types and normalisation.
 *
 * Three shapes exist in the wild:
 *   - V1 ("flat"): name/description/personality/... at the top level. Still very
 *     common in older downloads.
 *   - V2 (`chara_card_v2`): the same fields under `data`.
 *   - V3 (`chara_card_v3`): V2 plus `data.assets` and friends. SillyTavern reads
 *     the V3 chunk first when both are present.
 *
 * Everything normalises to `CharacterCard` so the rest of the code never has to
 * branch on the version.
 */

export interface CharacterCardData {
    name: string;
    description?: string;
    personality?: string;
    scenario?: string;
    first_mes?: string;
    mes_example?: string;
    creator_notes?: string;
    system_prompt?: string;
    post_history_instructions?: string;
    alternate_greetings?: string[];
    tags?: string[];
    creator?: string;
    character_version?: string;
    extensions?: Record<string, unknown>;
    /** V3 and up */
    assets?: unknown[];
    [key: string]: unknown;
}

export interface CharacterCard {
    spec: string;
    spec_version: string;
    data: CharacterCardData;
}

export const CARD_SPEC_V2 = 'chara_card_v2';
export const CARD_SPEC_V3 = 'chara_card_v3';

function asString(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value : fallback;
}

function asStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.filter((item): item is string => typeof item === 'string');
}

/**
 * True when the object looks like a flat V1 card rather than a wrapped one.
 */
export function isV1Card(raw: unknown): boolean {
    if (raw === null || typeof raw !== 'object') {
        return false;
    }

    const record = raw as Record<string, unknown>;
    const wrapped = typeof record.spec === 'string' && record.data !== null && typeof record.data === 'object';

    return !wrapped && ('name' in record || 'description' in record || 'first_mes' in record);
}

/**
 * Accept anything card-shaped and return a V2-normalised structure.
 * Throws only when the input cannot be a card at all.
 */
export function normalizeCard(raw: unknown): CharacterCard {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('card data is not an object');
    }

    const record = raw as Record<string, unknown>;

    let spec = CARD_SPEC_V2;
    let specVersion = '2.0';
    let data: Record<string, unknown>;

    if (typeof record.spec === 'string' && record.data !== null && typeof record.data === 'object' && !Array.isArray(record.data)) {
        spec = record.spec;
        specVersion = asString(record.spec_version, '2.0');
        data = record.data as Record<string, unknown>;
    } else if (isV1Card(record)) {
        data = { ...record };
    } else {
        throw new Error('card data has neither a spec/data wrapper nor V1 fields');
    }

    const normalized: CharacterCardData = {
        ...data,
        name: asString(data.name),
        description: asString(data.description),
        personality: asString(data.personality),
        scenario: asString(data.scenario),
        first_mes: asString(data.first_mes),
        mes_example: asString(data.mes_example),
        creator_notes: asString(data.creator_notes),
        system_prompt: asString(data.system_prompt),
        post_history_instructions: asString(data.post_history_instructions),
        alternate_greetings: asStringArray(data.alternate_greetings),
        tags: asStringArray(data.tags),
        creator: asString(data.creator),
        character_version: asString(data.character_version, '1.0'),
        extensions: (data.extensions !== null && typeof data.extensions === 'object' && !Array.isArray(data.extensions))
            ? data.extensions as Record<string, unknown>
            : {},
    };

    return { spec, spec_version: specVersion, data: normalized };
}

/**
 * Serialise as V2, which is what SillyTavern writes into the `chara` chunk.
 * V3 differences are applied on top when writing the `ccv3` chunk.
 */
export function toV2Json(card: CharacterCard): string {
    return JSON.stringify({ spec: CARD_SPEC_V2, spec_version: '2.0', data: card.data }, null, 4);
}

export function toV3Json(card: CharacterCard): string {
    return JSON.stringify({ spec: CARD_SPEC_V3, spec_version: '3.0', data: card.data }, null, 4);
}
