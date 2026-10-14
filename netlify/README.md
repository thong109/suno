# Music Studio vocal generation

The bolero vocal workflow uses two server-side services:

1. ElevenLabs Music generates a complete song from the submitted lyrics and style.
2. AudioShake separates the lead vocal into a WAV track for the studio mixer.

The original generated accompaniment is discarded. The separated vocal is not guaranteed to match the studio beat or to be free of backing-music artifacts; align it manually in the mixer.

## Netlify configuration

Deploy the site with Netlify Functions enabled, then add these environment variables in the Netlify site settings:

- `ELEVENLABS_API_KEY`: an ElevenLabs API key with Music API access.
- `AUDIOSHAKE_API_KEY`: an AudioShake API key with vocal separation access.
- `MUSIC_AI_ACCESS_CODE`: a long, private access code users enter in Music Studio.

Keep these values server-side. Never add provider keys to HTML or browser JavaScript. For local testing, use Netlify Dev with the values configured in its local environment; opening `music.html` directly with `file://` does not run the function.

Review both providers' current plans and terms before enabling this workflow for other users or distributing generated audio. AudioShake vocal separation is billed in credits by source duration; ElevenLabs Music requires an eligible paid plan.
