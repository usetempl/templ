/** The event that asks whichever shell mounted the profile
 * dialog to open it. Kept apart from the dialog so shells can listen without
 * loading the dialog's code until it is needed. */
export const PROFILE_SETTINGS_EVENT = "templ:open-profile";
