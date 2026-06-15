# Asset Catalog — Annotated for 5-Beat Template

Dihasilkan `scripts/annotate_assets.py`. Fitur audio diukur dari file asli; penempatan dianotasi LLM (Novita) ke timeline template 5-beat.

| File | Tipe | Kategori | Energi | Durasi | Beat | Trigger | Makna |
|---|---|---|---|---|---|---|---|
| `assets/sfx/bruh.mp3` | audio | impact_stinger | high | 1.30s | climax, transition | shock_reveal, fail_moment | Ungkapan kekecewaan atau ketidakpercayaan yang mendadak. |
| `assets/sfx/fahhh.mp3` | audio | fail_sound | low | 2.28s | kronologi, reaksi_netizen | awkward_silence, realization_react | Nafas panjang menandakan kelelahan, kekecewaan, atau penyerahan diri. |
| `assets/sfx/impact-hit.mp3` | audio | impact_stinger | high | 3.19s | climax, hook | zoom_punch, shock_reveal | Suara benturan keras untuk menandai puncak aksi atau kejutan. |
| `assets/sfx/notification.mp3` | audio | notification | medium | 1.07s | reaksi_netizen, intro_tokoh | comment_appear, profile_appear | Pemberitahuan masuk, biasanya untuk menandai komentar atau update penting. |
| `assets/sfx/record-scratch.mp3` | audio | record_scratch | high | 0.78s | climax, transition | freeze_rewind, suspicion_moment | Efek suara untuk menghentikan aksi secara dramatis, menandai momen awkward atau perubahan arah. |
| `assets/sfx/rizz.mp3` | audio | musical_sting | high | 5.09s | hook, outro | flex_moment, hype_react | Musik pendek yang menunjukkan kepercayaan diri, gaya, atau keberhasilan sosial. |
| `assets/sfx/sadtrombone.mp3` | audio | fail_sound | low | 3.63s | kronologi, reaksi_netizen | fail_moment, cringe_react | Melodi menyedihkan untuk menandai kegagalan atau momen memalukan. |
| `assets/sfx/sus.mp3` | audio | meme_vocal | medium | 2.90s | kronologi, climax | suspicion_moment, confused_react | Kata 'sus' untuk menandai kecurigaan atau sesuatu yang mencurigakan. |
| `assets/sfx/tuco-get-out.mp3` | audio | impact_stinger | high | 1.03s | climax, outro | rage_react, censor_block | Teriakan marah untuk menandai pengusiran atau penolakan tegas. |
| `assets/sfx/vine-boom.mp3` | audio | impact_stinger | high | 1.31s | climax, hook | zoom_punch, shock_reveal | Ledakan klasik dari Vine untuk menandai puncak atau twist lucu. |
| `assets/sfx/whoose-swipe.mp3` | audio | whoosh_transition | medium | 1.23s | transition | scene_change | Suara swipe cepat untuk transisi antar scene atau elemen visual. |
| `assets/sfx/whoosh-swipe.mp3` | audio | whoosh_transition | medium | 0.97s | transition | scene_change | Suara whoosh untuk transisi cepat dan dinamis antar bagian video. |
| `assets/sfx/windows-xp-startup.mp3` | audio | musical_sting | low | 4.91s | hook, intro_tokoh | profile_appear, number_callout | Nostalgia atau pembukaan klasik untuk menandai awal sesuatu yang penting atau lucu. |
| `assets/meme/Confused-Nick-Young.mp4` | video | meme_reaction | medium | 4.27s | kronologi, reaksi_netizen | confused_react, suspicion_moment | Ekspresi bingung untuk menunjukkan ketidakpahaman atau keheranan. |
| `assets/meme/Higuruma-facepalm-meme.mp4` | video | meme_reaction | medium | 13.10s | kronologi, reaksi_netizen | facepalm_react, cringe_react | Gerakan facepalm untuk menunjukkan kekecewaan, frustrasi, atau ketidaksabaran. |
| `assets/meme/Keyboard-smash.mp4` | video | meme_reaction | high | 8.10s | kronologi, climax | rage_react, fail_moment | Menghancurkan keyboard untuk menunjukkan kemarahan atau keputusasaan ekstrem. |
| `assets/meme/Leonardo-DiCaprio-Pointing-Meme.mp4` | video | meme_reaction | medium | 4.99s | kronologi, intro_tokoh | number_callout, emphasis_word | Menunjuk dengan percaya diri untuk menyoroti seseorang atau sesuatu yang penting. |
| `assets/meme/No-Signal-pattern.mp4` | video | meme_transition | low | 4.60s | transition, climax | freeze_rewind, awkward_silence | Pola no signal untuk menandai gangguan, kekosongan, atau transisi absurd. |
| `assets/meme/Yea-Boi.mp4` | video | meme_reaction | high | 4.16s | reaksi_netizen, outro | hype_react, agree_react | Ekspresi gembira dan setuju untuk menunjukkan kegembiraan atau persetujuan. |
| `assets/meme/black-guy-crying.mp4` | video | meme_reaction | high | 8.31s | kronologi, reaksi_netizen | rage_react, cringe_react | Ekspresi menangis ekstrem untuk menunjukkan kekecewaan atau kesedihan yang sangat dalam. |
| `assets/meme/clapping.mp4` | video | meme_reaction | medium | 13.49s | reaksi_netizen, outro | applause_react, agree_react | Tepuk tangan untuk menunjukkan apresiasi, persetujuan, atau ironi. |
| `assets/meme/mashup-screaming-woodchuck.mp4` | video | meme_reaction | high | 12.26s | climax, kronologi | shock_reveal, rage_react | Teriakan histeris dari tupai untuk menunjukkan kepanikan atau kegilaan. |
| `assets/meme/sweaty-gamer.mp4` | video | meme_reaction | high | 9.61s | kronologi, reaksi_netizen | fail_moment, cringe_react | Gamer berkeringat untuk menunjukkan stres, fokus, atau kegagalan dalam game. |
| `assets/meme/think-about-it.mp4` | video | meme_reaction | low | 1.97s | outro, kronologi | realization_react, suspicion_moment | Mengajak penonton untuk berpikir ulang atau merenungkan sesuatu yang mendalam. |
| `assets/ui/Crumpled-Black-Paper-Stop-Motion-Anim.mp4` | video | meme_transition | low | 16.65s | transition, outro | scene_change | Animasi kertas hitam yang terlipat untuk transisi gelap atau misterius. |
| `assets/ui/Paper-Grid-Background.mp4` | background | background (**PRIMARY**) | low | 15.12s | base | — | **PRIMARY background** montase Animelorian (config `[animelorian] paper_bg`): kertas hitam grid/graph-paper, bersih & netral, 1080x1920. Kanvas dasar tempat kartu footage/komentar ditempel — BUKAN cue/transisi. |
| `assets/fonts/Montserrat-ExtraBold.ttf` | font | font_display | high | — | hook, intro_tokoh | emphasis_word | Font tebal untuk judul besar atau teks utama yang menonjol. |
| `assets/fonts/Poppins-Bold.ttf` | font | font_display | medium | — | intro_tokoh, kronologi | number_callout | Font bold yang bersih untuk teks penting atau subjudul. |
| `assets/fonts/Poppins-Regular.ttf` | font | font_body | low | — | kronologi, reaksi_netizen | comment_appear | Font standar untuk teks narasi atau deskripsi panjang. |
