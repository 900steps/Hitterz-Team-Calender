// ① Fill these two values from Supabase Dashboard → Project Settings → API (or "Connect").
//    The publishable / anon key is safe to put on a public website: the database
//    rules (Row Level Security) decide what every logged-in user may see or change.
export const SUPABASE_URL = "https://YOUR-PROJECT-REF.supabase.co";
export const SUPABASE_KEY = "YOUR-PUBLISHABLE-OR-ANON-KEY";

// ② Website title shown in the header and browser tab.
export const SITE_TITLE = "Team Calendar";

// Usernames are turned into e-mail addresses "<username>@team.local" behind the scenes.
// Must match EMAIL_DOMAIN in supabase/functions/admin-users/index.ts
export const EMAIL_DOMAIN = "team.local";
