// biome-ignore-all lint/style/useFilenamingConvention: This is the repo-owned catalog manifest.

export type CatalogManifestKind = "music" | "sfx";

export interface CatalogManifestItem {
  description: string;
  sourceRange?: {
    sourceEndUs: number;
    sourceStartUs: number;
  };
  sourceUrl: string;
  title: string;
}

export const MANAGED_CATALOG_KINDS = [
  "music",
  "sfx",
] as const satisfies readonly CatalogManifestKind[];

/**
 * Edit this file to update the public catalog. CI sends this data to the
 * already-deployed reconcile action, so this file is not part of the Convex
 * function bundle.
 */
export const PUBLIC_CATALOG = [
  {
    sourceUrl: "https://www.youtube.com/watch?v=9SBNCYkSceU",
    title: "Hand Covers Bruise — Trent Reznor & Atticus Ross",
    description:
      "Sparse piano over uneasy electronic ambience, restrained and slightly reflective rather than fully calm. A flexible background choice for thoughtful storytelling, serious talking heads, education, technology, or low-key tension. Avoid very high-energy, celebratory, or playful edits.",
    // The opening 15 s is near-silent ambience; at bed volume it reads as no music.
    sourceRange: {
      sourceStartUs: 15_000_000,
      sourceEndUs: 263_800_000,
    },
  },
  {
    sourceUrl: "https://www.youtube.com/watch?v=-VzyB87A08U",
    title: "New Computers — Girlfriends",
    description:
      "Lo-fi indie rock with a youthful, curious, slightly messy pulse. A versatile choice for informational or educational videos, especially when someone is explaining a specific niche, creative obsession, or subculture. Avoid polished corporate pieces and epic, high-stakes reveals.",
  },
  {
    sourceUrl: "https://www.youtube.com/watch?v=Dy6iD-aTVHY",
    title: "NOW OR NEVER — TKANDZ & CXSPER (Instrumental)",
    description:
      "Dreamy melodic rap instrumental with a confident, motivational lift. Best reserved for real-life documentation of someone attempting, building, or accomplishing something epic and cool. Do not use it as a bed for a raw or simple talking head.",
  },
  {
    sourceUrl: "https://www.youtube.com/watch?v=P5y6X5cKNC4",
    title: "GONE, GONE / THANK YOU — Tyler, The Creator",
    description:
      "Fast-moving alternative hip-hop and soul with an energetic beat and real emotional stakes. Use for challenge videos, consequential stories, and high-stakes moments where the outcome matters. Do not use it for a simple talking head or low-key explanation.",
    sourceRange: {
      sourceStartUs: 277_000_000,
      sourceEndUs: 377_000_000,
    },
  },
  {
    sourceUrl: "https://www.youtube.com/watch?v=hBI-WX1xmdE",
    title: "9 (Instrumental) — Drake",
    description:
      "Spacious trap instrumental with cool, controlled intensity. Works well across interesting talking heads, confident explanations, focused work, and stories that need more edge than calm background music. Avoid soft, wholesome sentiment and playful comedy.",
  },
  {
    sourceUrl: "https://www.youtube.com/watch?v=JuSsvM8B4Jc",
    title: "Cornfield Chase — Hans Zimmer",
    description:
      "Hopeful organ-led cinematic music with a patient rise in scale and tension. A flexible choice for big ideas, thoughtful storytelling, discovery, ambition, and sections that should gradually feel more important. Avoid small jokes and moments meant to feel casual or trivial.",
  },
  {
    sourceUrl: "https://www.youtube.com/watch?v=Cq54DnQQ4h4",
    title: "Every Living Breathing Moment — Grant Steller",
    description:
      "Tender piano-led cinematic music with a warm, gentle emotional rise. A dependable background track for educational talking heads, personal stories, thoughtful explanations, and almost anything that is not especially intense. Avoid high-pressure action, menace, and hard-edged confidence.",
  },
  {
    sourceUrl: "https://www.youtube.com/watch?v=fxdJInWWGtU",
    title: "Runaway (Instrumental) — Kanye West",
    description:
      "Sparse piano that grows into a heavy, remorseful hip-hop instrumental. Best reserved for transformations, intense self-reflection, mistakes, improvement, downfall, and redemption. Avoid ordinary talking heads, carefree wins, and light comedy.",
  },
  {
    sourceUrl: "https://www.youtube.com/watch?v=WDjMC5Gn63M",
    title: "Everything in Its Right Place (Instrumental) — Radiohead",
    description:
      "Hypnotic electronic instrumental built from warm, repetitive synth chords with a slightly uncanny edge. A strong general bed for serious talking heads, education, technology, systems, and thoughtful explanations. Avoid jokes, goofy edits, and cheerful celebration.",
  },
  {
    sourceUrl: "https://www.youtube.com/watch?v=4JZ-o3iAJv4",
    title: "Can You Hear the Music — Ludwig Göransson",
    description:
      "Rapidly accelerating orchestral patterns that turn intellectual wonder into mounting intensity. Use for videos that need strong emphasis and buildup, especially breakthroughs, obsessive work, major ideas, and ambitious reveals. Do not use it as unobtrusive background music for an ordinary explanation.",
  },
  {
    sourceUrl: "https://www.youtube.com/watch?v=b59ghNkQC6k",
    title: "Summer (Presto) — Baroque Festival Orchestra",
    description:
      "Breakneck baroque strings with the feeling of a storm and steadily escalating pressure. Works well for challenges, deadlines, rising tension, frantic processes, and situations that keep becoming more difficult. Do not use it for a chill talking head or calm explanation.",
  },
  {
    sourceUrl: "https://www.youtube.com/watch?v=43EJPhEhArA",
    title: "Freedom (Instrumental) — Pharrell Williams",
    description:
      "Bright, percussive pop-funk instrumental with an upbeat, confident lift. A versatile choice for normal talking heads that need some energy, optimistic education, progress, launches, and wins. Avoid grief, ominous tension, and quiet introspection.",
  },
  {
    sourceUrl: "https://www.youtube.com/watch?v=3B9hiYyYhkk",
    title: "Whisper My Name (Instrumental) — Drake",
    description:
      "Nocturnal hip-hop and R&B instrumental with a cool, self-assured pulse. Works broadly for compelling talking heads, confident ideas, lifestyle footage, and stories that need more intensity and attitude than calm background music. Avoid cheerful family sentiment and frantic comedy.",
  },
  {
    sourceUrl: "https://www.youtube.com/watch?v=cCJ2OX6V0A8",
    title: "Walking on a Dream (Instrumental) — Empire of the Sun",
    description:
      "Upbeat synth-pop instrumental with an airy, optimistic, slightly nostalgic feel. A flexible choice for positive or chill videos, casual explanations, travel, friendship, lifestyle footage, and new beginnings. Avoid menace, grief, and hard-edged intensity.",
  },
  {
    sourceUrl: "https://www.youtube.com/watch?v=tlUcpEE8A0Q",
    title: "Hey Kids — Molina feat. Late Verlane",
    description:
      "Psychedelic dream-pop with soft vocals, hazy nostalgia, and a slightly eerie edge. A fairly flexible choice for thoughtful or educational videos, creative ideas, art, memory, and reflective talking heads. Avoid hard-edged action and dialogue mixes where the vocals compete with the speaker.",
  },
  {
    sourceUrl: "https://www.youtube.com/watch?v=Yczul_609Gg",
    title: "In Motion — Trent Reznor & Atticus Ross",
    description:
      "Propulsive electronic score with a crisp pulse and controlled urgency. Works especially well for technology, education, coding, systems, building, and fast explanations that need more drive than Hand Covers Bruise. Avoid intimate stories and relaxed emotional reflection.",
  },
  {
    sourceUrl: "https://www.youtube.com/watch?v=LiXIoqGXfh8",
    title: "Timeless (Instrumental) — The Weeknd & Playboi Carti",
    description:
      "Dark, glossy trap instrumental driven by large, hard-hitting beats and swagger. Use for bigger, more intense videos, confident reveals, fashion, competition, nightlife, and moments that should land with weight. Avoid ordinary low-key talking heads, warm sentiment, and gentle instruction.",
  },
  {
    sourceUrl: "https://www.youtube.com/watch?v=O_5gPfLJ5v4",
    title: "Dark Red (Instrumental) — Steve Lacy",
    description:
      "Warm lo-fi psychedelic soul and R&B instrumental with nostalgic unease. Best reserved for memories, complicated relationships, looking back, loneliness, and reflective montages that should not feel fully happy. Avoid bright celebration, neutral educational videos, and straightforward feel-good stories.",
  },
  {
    sourceUrl:
      "https://www.myinstants.com/en/instant/popular-riser-metallic-sound-effect-41559/",
    title: "Metallic Riser",
    description:
      "A bright metallic rise that builds anticipation into a clear peak. Use before a reveal, transformation, beat-drop-like change in visual energy, important claim, or transition into a more intense section. Place it so the end of the sound reaches the visual event. Avoid routine cuts, small on-screen elements, and moments with no meaningful buildup.",
    sourceRange: {
      sourceStartUs: 50_000,
      sourceEndUs: 1_950_000,
    },
  },
  {
    sourceUrl: "https://www.myinstants.com/en/instant/whoosh-sfx-32736/",
    title: "Whoosh — Fast",
    description:
      "A very short, sharp whoosh for quick visible movement. Use across fast punch-ins, snap zooms, swipes, whip-like cuts, and small graphics that move rapidly on or off screen. Let the sound span the motion instead of treating it as an impact. Avoid slow transitions, static reveals, and gentle text entrances.",
    sourceRange: {
      sourceStartUs: 180_000,
      sourceEndUs: 550_000,
    },
  },
  {
    sourceUrl: "https://www.myinstants.com/en/instant/simple-whoosh-76933/",
    title: "Whoosh — Medium",
    description:
      "A clean medium-length whoosh for ordinary visible movement. Use across slides, moderate punch-ins, moving text or images, and transitions whose motion is noticeable but not extreme. Let the sound span the movement. Avoid static appearances, tiny UI interactions, and slow cinematic transitions.",
    sourceRange: {
      sourceStartUs: 20_000,
      sourceEndUs: 450_000,
    },
  },
  {
    sourceUrl: "https://www.myinstants.com/en/instant/transition-whoosh-87155/",
    title: "Whoosh — Long",
    description:
      "A sustained transition whoosh for large or extended visible movement. Use across slow camera moves, full-screen transitions, long slides, and major visual changes that need a broader sweep. Align its development with the motion and let it finish as the move settles. Avoid quick punch-ins, small text, and simple UI events.",
    sourceRange: {
      sourceStartUs: 130_000,
      sourceEndUs: 2_070_000,
    },
  },
  {
    sourceUrl: "https://www.myinstants.com/en/instant/pop-sfx-75405/",
    title: "Pop — Clean",
    description:
      "A short, clean pop that gives an on-screen appearance a playful landing. Use selectively when important text, an image, a sticker, a label, or another visual element shows up on screen. Place the pop on the appearance. Do not automatically add it to every caption, image, or element, and avoid serious or understated moments where a playful accent would be distracting.",
    sourceRange: {
      sourceStartUs: 20_000,
      sourceEndUs: 280_000,
    },
  },
  {
    sourceUrl: "https://www.myinstants.com/en/instant/mouse-click-84937/",
    title: "Mouse Click — High",
    description:
      "A short, high-pitched mouse click with a light and precise feel. Use selectively when on-screen text, an image, a cursor target, a button, a choice, or another UI-like element appears or is selected. Place it on the visible interaction or appearance. Do not click every caption or every element that enters the frame; avoid organic, emotional, or cinematic moments with no digital or graphic character.",
    sourceRange: {
      sourceStartUs: 30_000,
      sourceEndUs: 230_000,
    },
  },
  {
    sourceUrl: "https://www.myinstants.com/en/instant/mouse-click-sound-63406/",
    title: "Mouse Click — Low",
    description:
      "A short, low-pitched mouse click with more weight than the high click. Use selectively when important on-screen text, an image, a button, a choice, or another UI-like element appears or is selected and should feel firm or deliberate. Place it on the visible interaction or appearance. Do not click every caption or every element, and avoid light playful moments better served by the high click or clean pop.",
    sourceRange: {
      sourceStartUs: 1_000_000,
      sourceEndUs: 1_240_000,
    },
  },
  {
    sourceUrl:
      "https://www.myinstants.com/en/instant/keyboard-single-click-67301/",
    title: "Keyboard Click — Single",
    description:
      "One compact keyboard-key press with a crisp mechanical character. Use for a visible keystroke, typed command, search submission, text-entry moment, or precise technology-related change on screen. Place it on the key action. Avoid using a single click as a typing loop, decorating ordinary captions, or adding it where no keyboard-like action is implied.",
    sourceRange: {
      sourceStartUs: 0,
      sourceEndUs: 250_000,
    },
  },
  {
    sourceUrl: "https://www.myinstants.com/en/instant/fahhhhhhhhhhhhhh-3525/",
    title: "FAHHH — Meme",
    description:
      "A loud, distorted vocal 'FAHHH' reaction for chaotic meme editing. Use on a cursed reveal, painful failure, embarrassment, disgust, or a moment when the situation suddenly becomes much worse. It usually lands on the reveal or immediately on the reaction that follows. Use sparingly unless the creator asks for repetition; avoid sincere emotion, polished informational edits, and mild moments that do not justify an extreme reaction.",
    sourceRange: {
      sourceStartUs: 40_000,
      sourceEndUs: 1_930_000,
    },
  },
  {
    sourceUrl: "https://www.myinstants.com/en/instant/vine-boom-sound-70972/",
    title: "Vine Boom — Meme",
    description:
      "An exaggerated bass-heavy boom with a long reverberant tail, recognizable as a meme reaction. Use on an absurdly dramatic realization, suspicious statement, deadpan look, shocking reveal, or intentionally overdramatic zoom. Place the initial hit on the visual event. Use sparingly unless the creator asks for repetition; avoid sincere emotional moments and ordinary informational emphasis.",
    sourceRange: {
      sourceStartUs: 50_000,
      sourceEndUs: 1_260_000,
    },
  },
] as const satisfies readonly CatalogManifestItem[];
