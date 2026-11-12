/**
 * PLUGINS ON A PHONE (fork, upstream 0.6.0 merge; owner's decision: "Hide the
 * ways in, park plugin questions"). Plugins are hidden in the phone layout
 * for now:
 *   - the ways in (the lesson's top-bar plugin buttons, the sidebar's plugin
 *     entries, the graph's plugin buttons) are hidden by app/phone.css;
 *   - a plugin page opened directly shows one sentence
 *     (components/phone/phone-plugin-page.tsx);
 *   - Settings lists no plugin rows, and a link to one lands on the list
 *     (components/settings/settings-dialog.tsx);
 *   - a plugin question the teacher asks is parked
 *     (components/phone/parked-plugin-question.tsx).
 *
 * Kept free of component imports, so Settings and the tests can read it
 * without loading the plugin machinery.
 */

/** The owner's wording for a plugin page opened on a phone. */
export const PLUGIN_PAGE_PHONE_TEXT = "Open this on a computer.";

/** The owner's wording in place of a plugin question's box on a phone. */
export const PARKED_PLUGIN_QUESTION_TEXT = "This question needs a bigger screen. Open this session on a computer to answer it.";

/** Settings sections that belong to plugins: the two management rows and
 *  every plugin's own page (`plugin:<id>`). */
export function isPluginSettingsSection(section: string): boolean {
	return section === "core-plugins" || section === "plugins" || section.startsWith("plugin:");
}
