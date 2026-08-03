# @kit/reel-strip

The lightbox film-strip's pure core, extracted from `LightboxDesktop.tsx` +
`src/dataHelpers.ts`: navigation over grouped items in BOTH modes via a
`ReelSource<G>` **accessor view** (no adapter arrays — navigation reads your live
jobs array allocation-free; reel steps visible items via bounded loops, grid mode
steps whole groups ignoring visibility, a preserved behavior), the wheel-swipe
state machine (`nextSwipeDirection` transition table + `swipeStep` with
`ItemRef | null` candidates so the caller picks the mode), the strip's anchor
scan with **the anchor-exemption rule** (a focused-but-filtered image stays in the
strip unless server-filtered/`hardHidden`), and the anchor-morph geometry
(constant-total-size invariant by construction).

Freerange: 8/13 functions fully analyzed at 0 findings (pinned in
`scripts/fr-kit.ts`); the navigation functions take `ReelSource` accessors
(callbacks — outside the subset, the deliberate allocation-free trade), while the
machine/morph/travel scalars stay analyzed. Subset lessons encoded here: switch `break`s and fully-returning
switches are outside the subset (hence `nextSwipeDirection`/`resolveSwipe` as
return-style helpers), and `swipeStep` takes flat `direction`/`accumulated`
parameters — matching how the app stores them — so pixel-domain bounds are
assertable caller contracts.

App adoption status: `LightboxDesktop` and `styleLightboxGangGang` run on this
module. Remaining inline copies: the mobile lightboxes (divergent — intentionally
deferred pending the anchor-in-route behavior call) and `editorGangGang`'s own
machine copy + `dataHelpers` navigation (un-adopted; `profileImagePickerModal`
also uses `dataHelpers`).

## Geometry vs policy

Geometry: the strip walk, morph math, swipe machine shape. Policy (`feel.ts`
`mjFeel`): the 60px swipe commitment, 68/56 thumbnail sizes, 8px group gap. The
±2px `WHEEL_NOISE_FLOOR` is input-hardware calibration and stays a core constant.
Policy semantics to review when adopting elsewhere: the anchor-exemption rule and
grid mode ignoring visibility.
