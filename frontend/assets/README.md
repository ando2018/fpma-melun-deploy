# Assets FPMA

Les ressources statiques du site sont organisees ainsi :

- `images/` : logos, bannieres et autres images
- `documents/` : fichiers PDF et documents telechargeables
- `data/` : fichiers JSON utilises par l'application

Depuis un template Angular, une ressource se reference avec un chemin relatif a `src` :

```html
<img src="assets/images/fpma-logo.svg" alt="Logo FPMA">
<a href="assets/documents/guide-fpma.pdf" target="_blank" rel="noopener">Ouvrir le guide PDF</a>
```
