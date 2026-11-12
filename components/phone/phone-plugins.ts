/**
 * PLUGINS ON A PHONE (fork). Two core plugins are phone-ready, Flashcards
 * and Rich code blocks (owner's plan, docs/phone-plugins-plan.md, decisions
 * 1-3 and 11); every other plugin stays hidden in the phone layout, as at
 * the upstream 0.6.0 merge:
 *   - the ways in: only Flashcards' session-list entry shows
 *     (PHONE_SIDEBAR_ENTRIES). The lesson's top-bar plugin buttons, the
 *     graph's plugin buttons and every other session-list entry stay hidden
 *     by app/phone.css;
 *   - a plugin page opened on a phone renders for a phone-ready plugin and
 *     shows one sentence for any other (components/phone/phone-plugin-page.tsx);
 *   - Settings lists Core plugins and the own page of each phone-ready plugin
 *     that is on, after Account; no Community plugins row and no other
 *     plugin's page. A link to an unlisted plugin section lands on the list
 *     (components/settings/settings-dialog.tsx). On the Core plugins page the
 *     switches of the other core plugins are greyed and can't be changed, and
 *     their settings button is hidden (components/settings/plugins-section.tsx);
 *   - a plugin question the teacher asks is parked, with a way to dismiss
 *     it, and a plugin's practice problem is parked
 *     (components/phone/parked-plugin-question.tsx).
 *
 * The phone layouts of the two plugins' own screens live in
 * app/phone-flashcards.css and app/phone-rich-code-blocks.css.
 *
 * Kept free of component imports, so Settings and the tests can read it
 * without loading the plugin machinery.
 */

/** The plugins that work in the phone layout, by id. */
export const PHONE_READY_PLUGINS: readonly string[] = ["flashcards", "rich-code-blocks"];

/** The session-list entries shown on a phone, by their `data-plugin-action`
 *  key (`<plugin id>/<placement id>`, components/plugin-chrome.tsx). Every
 *  other plugin entry is hidden there; app/phone.css names these, and a test
 *  keeps the two equal. */
export const PHONE_SIDEBAR_ENTRIES: readonly string[] = ["flashcards/open-sidebar"];

export function isPhoneReadyPlugin(pluginId: string): boolean {
	return PHONE_READY_PLUGINS.includes(pluginId);
}

/** The owner's wording for a plugin page opened on a phone. */
export const PLUGIN_PAGE_PHONE_TEXT = "Open this on a computer.";

/** The owner's wording in place of a plugin question's box on a phone. */
export const PARKED_PLUGIN_QUESTION_TEXT = "This question needs a bigger screen. Open this session on a computer to answer it.";

/** The button under that sentence: upstream's own words for dismissing a
 *  plugin question (its dock shows them when the plugin is switched off). */
export const DISMISS_PLUGIN_QUESTION_TEXT = "Dismiss question";

/** The owner's wording in place of a plugin's practice problem on a phone. */
export const PARKED_PLUGIN_PROBLEM_TEXT = "This problem needs a bigger screen. Open this session on a computer to answer it.";

/** Settings sections that belong to plugins: the two management rows and
 *  every plugin's own page (`plugin:<id>`). */
export function isPluginSettingsSection(section: string): boolean {
	return section === "core-plugins" || section === "plugins" || section.startsWith("plugin:");
}

/** A plugin section a phone doesn't list: Community plugins, and the own
 *  page of every plugin that isn't phone-ready. A link to one lands on the
 *  section list. Core plugins and the phone-ready plugins' pages open. */
export function isPhoneHiddenSettingsSection(section: string): boolean {
	if (!isPluginSettingsSection(section)) return false;
	if (section === "core-plugins") return false;
	return !(section.startsWith("plugin:") && isPhoneReadyPlugin(section.slice("plugin:".length)));
}

/** On the Core plugins page on a phone: a core plugin that isn't phone-ready
 *  shows its switch greyed and unchangeable, and no settings button. */
export function isPhoneLockedPlugin(phone: boolean, plugin: { id: string; origin: string }): boolean {
	return phone && plugin.origin === "core" && !isPhoneReadyPlugin(plugin.id);
}
