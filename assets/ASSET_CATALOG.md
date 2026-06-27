# Asset Catalog — Annotated for 5-Beat Template

Dihasilkan `scripts/annotate_assets.py`. Fitur audio/video diukur dari file asli; penempatan dianotasi LLM (batched, in-vocab) ke timeline template 5-beat.

| File | Tipe | Kategori | Energi | Durasi | Beat | Trigger | Makna |
|---|---|---|---|---|---|---|---|
| `assets/sfx/anime-wow.mp3` | audio | meme_vocal | high | 4.20s | kronologi, reaksi_netizen, climax | shock_reveal, hype_react, realization_react | Ekspresi terkejut atau kagum yang berlebihan, seringkali ironis. |
| `assets/sfx/bruh.mp3` | audio | meme_vocal | medium | 1.30s | kronologi, reaksi_netizen | fail_moment, confused_react, facepalm_react | Menyatakan ketidakpercayaan, kekecewaan, atau kebingungan ringan. |
| `assets/sfx/cat-laugh.mp3` | audio | meme_vocal | high | 3.63s | kronologi, reaksi_netizen | cringe_react, fail_moment | Suara tawa kucing yang lucu dan sedikit mengganggu, untuk momen komedi. |
| `assets/sfx/duck-toy.mp3` | audio | impact_stinger | low | 0.96s | kronologi, reaksi_netizen | fail_moment, awkward_silence | Suara mainan bebek karet, untuk momen yang sedikit konyol atau tidak terduga. |
| `assets/sfx/error.mp3` | audio | impact_stinger | medium | 0.99s | kronologi, reaksi_netizen | fail_moment, disagree_react | Menandakan kesalahan, kegagalan, atau sesuatu yang tidak beres. |
| `assets/sfx/fahhh.mp3` | audio | meme_vocal | low | 2.28s | kronologi, reaksi_netizen | facepalm_react, fail_moment | Suara ekspresi kelelahan atau kekecewaan yang pasrah. |
| `assets/sfx/huh.mp3` | audio | meme_vocal | low | 0.62s | kronologi, reaksi_netizen | confused_react, suspicion_moment | Ekspresi kebingungan atau pertanyaan. |
| `assets/sfx/impact-hit.mp3` | audio | impact_stinger | high | 3.19s | kronologi, climax | zoom_punch, shock_reveal, emphasis_word | Suara benturan keras, untuk menekankan momen penting atau kejutan. |
| `assets/sfx/loading-lost-connection.mp3` | audio | ambient | low | 2.69s | kronologi, reaksi_netizen | awkward_silence, fail_moment, confused_react | Suara loading dan koneksi terputus, untuk momen kebingungan atau kegagalan teknis. |
| `assets/sfx/notification.mp3` | audio | notification | low | 1.07s | intro_tokoh, reaksi_netizen, kronologi | profile_appear, comment_appear, number_callout | Suara notifikasi, untuk menarik perhatian pada elemen baru di layar. |
| `assets/sfx/punch-gaming.mp3` | audio | impact_stinger | high | 1.53s | kronologi, climax | zoom_punch, emphasis_word, flex_moment | Suara pukulan ala game, untuk menekankan aksi atau momen 'epic'. |
| `assets/sfx/record-scratch.mp3` | audio | record_scratch | medium | 0.78s | kronologi, reaksi_netizen, climax | shock_reveal, freeze_rewind, awkward_silence | Suara piringan hitam berhenti mendadak, untuk menghentikan narasi atau menunjukkan perubahan tak terduga. |
| `assets/sfx/rizz.mp3` | audio | meme_vocal | high | 5.09s | kronologi, reaksi_netizen | flex_moment, hype_react | Suara 'rizz' yang menunjukkan karisma atau daya tarik yang kuat, seringkali ironis. |
| `assets/sfx/sadtrombone.mp3` | audio | musical_sting | low | 3.63s | kronologi, reaksi_netizen, outro | fail_moment, facepalm_react, awkward_silence | Suara trombon sedih, untuk momen kegagalan, kekecewaan, atau ironi. |
| `assets/sfx/steve-old-hurt.mp3` | audio | fail_sound | medium | 1.07s | kronologi, climax | fail_moment, shock_reveal | Suara sakit/terkejut, cocok untuk momen kegagalan atau kejutan kecil. |
| `assets/sfx/sus.mp3` | audio | meme_vocal | low | 2.90s | kronologi, climax | suspicion_moment | Menandakan kecurigaan atau ada sesuatu yang tidak beres. |
| `assets/sfx/tuco-get-out.mp3` | audio | meme_vocal | high | 1.03s | kronologi, reaksi_netizen, climax | rage_react, disagree_react | Ekspresi marah atau pengusiran, cocok untuk momen penolakan atau ketidaksetujuan. |
| `assets/sfx/vine-boom.mp3` | audio | impact_stinger | high | 1.31s | hook, kronologi, climax | shock_reveal, zoom_punch, emphasis_word | Efek suara hentakan yang kuat, cocok untuk momen kejutan, penekanan, atau zoom-punch. |
| `assets/sfx/whoose-swipe.mp3` | audio | whoosh_transition | medium | 1.23s | transition, kronologi | scene_change | Suara sapuan cepat, ideal untuk transisi antar scene atau perpindahan cepat. |
| `assets/sfx/whoosh-swipe.mp3` | audio | whoosh_transition | medium | 0.97s | transition, kronologi | scene_change | Suara sapuan cepat, ideal untuk transisi antar scene atau perpindahan cepat. |
| `assets/sfx/windows-xp-startup.mp3` | audio | musical_sting | low | 4.91s | intro_tokoh, outro | profile_appear, realization_react | Suara nostalgia yang menandakan awal atau 'boot up' suatu ide/konsep. |
| `assets/meme/ mengetik-keyboard.mp4` | video | meme_reaction | medium | 1.79s | kronologi, reaksi_netizen | emphasis_word, suspicion_moment | Menunjukkan seseorang sedang mengetik dengan cepat atau mencari informasi dengan intens. |
| `assets/meme/Confused-Nick-Young.mp4` | video | meme_reaction | low | 2.18s | kronologi, reaksi_netizen | confused_react, suspicion_moment | Digunakan untuk mengekspresikan kebingungan atau ketidakpahaman terhadap suatu situasi. |
| `assets/meme/Higuruma-facepalm-meme.mp4` | video | meme_reaction | medium | 3.25s | kronologi, reaksi_netizen | facepalm_react, cringe_react, fail_moment | Digunakan untuk menunjukkan rasa frustrasi, malu, atau tidak percaya akan suatu kejadian bodoh. |
| `assets/meme/Keyboard-smash.mp4` | video | meme_reaction | high | 8.03s | kronologi, reaksi_netizen | rage_react, fail_moment | Digunakan untuk menunjukkan rasa frustrasi atau kemarahan ekstrem. |
| `assets/meme/Leonardo-DiCaprio-Pointing-Meme.mp4` | video | meme_reaction | medium | 3.32s | kronologi, reaksi_netizen | realization_react, emphasis_word | Digunakan untuk menunjuk atau mengidentifikasi sesuatu yang menarik perhatian, seringkali dengan nada sarkasme atau 'aha!' |
| `assets/meme/No-Signal-pattern.mp4` | video | meme_transition | medium | 4.60s | transition, kronologi, climax | scene_change, shock_reveal, fail_moment | Digunakan sebagai transisi untuk menunjukkan gangguan, kesalahan teknis, atau pergantian adegan yang tiba-tiba/tidak terduga. |
| `assets/meme/Yea-Boi.mp4` | video | meme_reaction | high | 4.16s | kronologi, reaksi_netizen, outro | hype_react, agree_react, flex_moment | Menunjukkan ekspresi kegembiraan, persetujuan, atau hype yang berlebihan. |
| `assets/meme/black-guy-crying.mp4` | video | meme_reaction | high | 3.02s | reaksi_netizen, climax | disagree_react, shock_reveal, rage_react | Menunjukkan reaksi sedih, terkejut, atau tidak percaya yang berlebihan. |
| `assets/meme/cat-thinking.mp4` | video | meme_reaction | low | 1.79s | kronologi, reaksi_netizen | confused_react, suspicion_moment, realization_react | Menunjukkan momen kebingungan, pemikiran mendalam, atau keraguan. |
| `assets/meme/clapping.mp4` | video | meme_reaction | medium | 13.49s | reaksi_netizen, outro | applause_react | Digunakan untuk menunjukkan apresiasi atau sarkasme terhadap suatu kejadian. |
| `assets/meme/jokowi-kaget.mp4` | video | meme_reaction | high | 1.21s | kronologi, reaksi_netizen | shock_reveal, confused_react | Digunakan saat ada momen yang mengejutkan atau tidak terduga. |
| `assets/meme/mashup-screaming-woodchuck.mp4` | video | meme_reaction | high | 1.95s | hook, kronologi, reaksi_netizen, climax | shock_reveal, rage_react | Digunakan untuk menunjukkan reaksi terkejut, kaget, atau ekspresi berlebihan terhadap suatu kejadian. |
| `assets/meme/sounding-hidup-jokowi.mp4` | video | meme_reaction | high | 1.44s | intro_tokoh, kronologi, reaksi_netizen, outro, climax | hype_react, flex_moment, applause_react | Digunakan untuk menunjukkan dukungan, semangat, atau momen 'flex' yang kuat dan bersemangat. |
| `assets/meme/sweaty-gamer.mp4` | video | meme_reaction | medium | 9.59s | kronologi, reaksi_netizen | confused_react, suspicion_moment | Menunjukkan ekspresi tegang, khawatir, atau sedang berpikir keras dalam situasi sulit. |
| `assets/meme/think-about-it.mp4` | video | meme_reaction | low | 0.95s | kronologi, outro | realization_react, suspicion_moment | Menunjukkan momen 'berpikir' atau 'mencerna' informasi, seringkali dengan nada menyindir atau 'mic drop'. |
| `assets/ui/Crumpled-Black-Paper-Stop-Motion-Anim.mp4` | video | meme_transition | medium | 16.65s | transition | scene_change | Transisi visual yang menunjukkan pergantian adegan atau topik secara dramatis, seperti meremas kertas. |
| `assets/ui/Paper-Grid-Background.mp4` | video | meme_transition | low | 15.12s | kronologi, reaksi_netizen | scene_change, number_callout | Latar belakang statis atau bergerak lambat yang memberikan kesan catatan, perencanaan, atau analisis. |
| `assets/fonts/Montserrat-ExtraBold.ttf` | font | font_display | high | — | hook, intro_tokoh, climax |  | Font tebal dan modern untuk judul utama atau penekanan kuat. |
| `assets/fonts/Poppins-Bold.ttf` | font | font_display | medium | — | intro_tokoh, kronologi, reaksi_netizen | profile_appear, number_callout, comment_appear | Font tebal dan mudah dibaca untuk highlight atau nama. |
| `assets/fonts/Poppins-Regular.ttf` | font | font_body | low | — | kronologi, reaksi_netizen, outro |  | Font standar yang bersih dan mudah dibaca untuk teks narasi atau detail. |
