// Active tool selection for the Mastra agent. (The active local model-adapter
// routing was retired upstream in commit 9e3687f9; only replay back-compat
// remains, and it lives with the signature guard, not here.)
//
// Ported verbatim from apps/web/src/lib/ultrapilot/mastra-provider.ts: the
// tool-name group constants and the follow-up narrowing heuristics.

import type { AssistantMessage } from "@ultrapilot/core/types";
import { collectLocalPlannerToolCallIds } from "./gemini-signature-guard";

export const READ_ONLY_TOOLS = [
	"get_timeline_state",
	"get_media_assets",
	"render_frame",
	"request_visual_choice",
] as const;

export const CLIP_TOOLS = [
	"get_scenes",
	"get_all_scenes_from_assets",
	"find_scenes",
	"insert_clip",
	"update_clip",
	"delete_clip",
] as const;

export const TEXT_TOOLS = ["add_text_element", "update_text_element"] as const;
export const STICKER_TOOLS = [
	"search_stickers",
	"add_sticker_element",
] as const;
export const EFFECT_TOOLS = [
	"list_effects",
	"add_clip_effect",
	"insert_effect_element",
] as const;
export const TRANSITION_TOOLS = [
	"list_transition_types",
	"add_transition",
	"update_transition",
	"remove_transition",
] as const;
export const MASK_TOOLS = ["list_mask_types", "add_mask_to_clip"] as const;
export const KEYFRAME_TOOLS = ["upsert_keyframes", "remove_keyframes"] as const;
export const CAPTION_TOOLS = [
	"generate_captions_from_timeline",
	"import_subtitle_content",
] as const;
export const SOUND_TOOLS = [
	"search_sound_effects",
	"add_sound_effect_to_timeline",
] as const;
export const MUSIC_SYNC_TOOLS = [
	"analyze_music",
	"get_music_sync_state",
	"create_music_aware_rough_cut",
	"plan_music_refinement",
	"apply_music_sync_plan",
	"cut_to_beats",
	"analyze_music_for_sync",
	"plan_music_driven_montage",
	"get_music_copilot_context",
	"get_music_copilot_plan",
	"apply_music_copilot_plan",
	"get_music_copilot_events",
	"get_timeline_anchors",
	"resolve_timeline_anchor",
	"plan_anchor_placement",
	"apply_anchor_placement",
] as const;
export const PROJECT_TOOLS = [
	"update_project_settings",
	"export_project",
] as const;
export const GENERATION_TOOLS = [
	"list_generated_assets",
	"run_media_job",
	"get_media_job",
	"import_generated_asset_to_project",
] as const;

export function latestUserText(messages: AssistantMessage[]): string {
	const latestUserMessage = [...messages]
		.reverse()
		.find((message) => message.role === "user");

	if (!latestUserMessage) {
		return "";
	}

	return latestUserMessage.parts
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n")
		.toLowerCase();
}

export function shouldNarrowFollowUpTools(
	messages: AssistantMessage[],
): boolean {
	const localPlannerToolCallIds = collectLocalPlannerToolCallIds(messages);
	const toolResults = messages.flatMap((message) =>
		message.role === "tool"
			? message.parts.flatMap((part) =>
					part.type === "tool-result" &&
					!localPlannerToolCallIds.has(part.toolCallId)
						? [part.toolName]
						: [],
				)
			: [],
	);

	return (
		toolResults.includes("set_conversation_title") &&
		toolResults.every((toolName) => toolName === "set_conversation_title")
	);
}

export function selectActiveMastraTools(input: {
	messages: AssistantMessage[];
	tools: Record<string, unknown>;
}): string[] | undefined {
	if (!shouldNarrowFollowUpTools(input.messages)) {
		return undefined;
	}

	const availableTools = new Set(Object.keys(input.tools));
	const userText = latestUserText(input.messages);
	const activeTools = new Set<string>();

	const addGroup = (group: readonly string[]) => {
		for (const toolName of group) {
			if (availableTools.has(toolName)) {
				activeTools.add(toolName);
			}
		}
	};

	const addIfMatches = (pattern: RegExp, group: readonly string[]) => {
		if (pattern.test(userText)) {
			addGroup(group);
		}
	};

	if (
		/\b(hello|hi|hey|greet|greeting|how are you)\b/.test(userText) &&
		!/\b(edit|video|timeline|clip|scene|caption|subtitle|text|sticker|effect|mask|keyframe|audio|sound|music|export|render)\b/.test(
			userText,
		)
	) {
		return [];
	}

	addGroup(READ_ONLY_TOOLS);
	addIfMatches(
		/\b(clips?|trimm?ing|trimm?ed|trims?|cuts?|cutting|splits?|splitting|timelines?|scenes?|footage|media|shots?|b-rolls?|inserts?|inserting|inserted|deletes?|deleting|deleted|removes?|removing|removed|replaces?|replacing|replaced)\b/,
		CLIP_TOOLS,
	);
	addIfMatches(/\b(texts?|titles?|overlays?|lower[ -]thirds?)\b/, TEXT_TOOLS);
	addIfMatches(/\b(stickers?|emojis?|icons?)\b/, STICKER_TOOLS);
	addIfMatches(
		/\b(effects?|filters?|looks?|color[ -]grad(e|ing)s?)\b/,
		EFFECT_TOOLS,
	);
	addIfMatches(
		/\b(transitions?|crossfades?|crossfading|crossfaded|dissolves?|dissolving|dissolved|wipes?|slides?)\b/,
		TRANSITION_TOOLS,
	);
	addIfMatches(
		/\b(masks?|masking|crops?|cropping|cropped|blur[ -]faces?|hide[ -]faces?)\b/,
		MASK_TOOLS,
	);
	addIfMatches(
		/\b(keyframes?|animat(e|ed|ing|ion)s?|motions?)\b/,
		KEYFRAME_TOOLS,
	);
	addIfMatches(
		/\b(captions?|captioning|subtitles?|subtitling|transcripts?|transcriptions?)\b/,
		CAPTION_TOOLS,
	);
	addIfMatches(
		/\b(sounds?|audios?|music|sfx|voices?|voice[ -]overs?)\b/,
		SOUND_TOOLS,
	);
	addIfMatches(
		/\b(music|beats?|downbeats?|drums?|sync(ing|ed|s)?|songs?|tempos?|rhythms?)\b/,
		MUSIC_SYNC_TOOLS,
	);
	addIfMatches(
		/\b(anchors?|snaps?|snapping|pulses?|impacts?|markers?|edit[ -]points?|words?|phrases?|hold|holds|held|holding)\b/,
		MUSIC_SYNC_TOOLS,
	);
	addIfMatches(
		/\b(exports?|exporting|renders?|rendering|resolutions?|fps|aspect[ -]ratios?|project[ -]settings?)\b/,
		PROJECT_TOOLS,
	);
	addIfMatches(
		/\b(generat(e|ed|ing|ion)s?|creat(e|ed|ing|ion)s?|ai[ -]images?|ai[ -]videos?)\b/,
		GENERATION_TOOLS,
	);

	return [...activeTools];
}
