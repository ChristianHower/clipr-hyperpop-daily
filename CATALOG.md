# CLIP//R search catalog

These are every artist and song combination currently accepted by the game and available in the private seven-day queue editor. `dist/catalog.js` is the source of truth; each entry uses the listed Deezer track ID for metadata and preview playback.

| Artist | Song | Deezer ID |
| --- | --- | ---: |
| glaive | astrid | 1008321682 |
| glaive | the prom | 2359450265 |
| glaive | fuck this town | 1422769872 |
| glaive | dnd | 1140400122 |
| Ninajirachi | Start Small | 1953278607 |
| Ninajirachi | iPod Touch | 3444573001 |
| Ninajirachi | Fuck My Computer | 3444573011 |
| Ninajirachi | Undo U | 2446155815 |
| Tiffany Day | FEEL ALRIGHT | 1191025852 |
| Tiffany Day | IF I DON'T TEXT YOU FIRST | 1403434832 |
| Tiffany Day | DREAMS ABT OPTIMISM | 1962117857 |
| Tiffany Day | KANSAS | 2886973192 |
| Frost Children | FLATLINE | 3492725931 |
| Frost Children | Shake It Like A | 3493513331 |
| Frost Children | SICK TRIP | 3492725941 |
| Frost Children | FOX BOP | 2017086967 |
| Porter Robinson | Look at the Sky | 3484515861 |
| Porter Robinson | Cheerleader | 3484513191 |
| Porter Robinson | Something Comforting | 3484515951 |
| Porter Robinson | Language | 937856142 |
| tsubi club | burbank house | 2853380062 |
| tsubi club | laced up | 2973230381 |
| tsubi club | BURNMATERIAL | 4004216351 |
| tsubi club | bbbackboard | 4004216421 |
| Jane Remover | homeswitcher | 2028806127 |
| Jane Remover | movies for guys | 1530489612 |
| Jane Remover | your clothes | 1530489562 |
| Jane Remover | Cage Girl / Camgirl | 2422706335 |
| underscores | Spoiled little brat | 1247701152 |
| underscores | Locals (Girls like us) | 3484490591 |
| underscores | Cops and robbers | 3484490581 |
| underscores | Old money bitch | 3484490651 |
| brakence | deepfake | 2041275807 |
| brakence | argyle | 1512084652 |
| brakence | cbd | 1625549192 |
| brakence | venus fly trap | 1814405247 |
| ericdoa | sad4whattt | 1629080302 |
| ericdoa | fantasize | 1379131632 |
| ericdoa | movinglikeazombie | 1087122272 |
| ericdoa | thingsudo2me (feat. brakence) | 1120765882 |
| 8485 | 1:15 | 1027752462 |
| 8485 | Special (feat. Alice Gas) | 961555162 |
| 8485 | hangar | 1306399552 |
| 8485 | 4real (feat. petal supply & umru) | 1049782142 |
| Alice Longyu Gao | Rich Bitch Juice | 814851732 |
| Alice Longyu Gao | LEGEND | 1875776197 |
| Alice Longyu Gao | I <3 Harajuku | 1862456447 |
| Alice Longyu Gao | 100 Boyfriends | 1876313017 |

## Adding another option

Add one object to `dist/catalog.js` with `deezerId`, `artist`, and `title`. You may also add a verified direct `soundcloud` URL. Without one, the result links to an exact artist-and-title search on SoundCloud.

Before adding a track, confirm that Deezer returns a readable 30-second preview for its ID.
