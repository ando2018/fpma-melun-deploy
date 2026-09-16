# fpma-backend

API backend pour le site [fpma-site](../fpma-site) : vaovao (annonces), évènements et sary (albums photo/vidéo).

## Installation et lancement

```bash
npm install
npm run dev     # avec rechargement auto (nodemon)
# ou
npm start
```

Le serveur écoute par défaut sur `http://localhost:3001` (variable d'env `PORT` pour changer).

## Persistance

- **Vaovao** et **Évènements** : stockés dans des fichiers JSON (`src/data/annonces.json`, `src/data/evenements.json`), lus/écrits directement à chaque requête. Pas de base de données.
- **Sary** : pas de fichier de données — chaque **sous-dossier** de `src/storage/sary/` est un album. Le serveur scanne ce dossier à chaque requête :
  - les fichiers image (`.jpg .jpeg .png .gif .webp`) et vidéo (`.mp4 .webm`) présents sont exposés tels quels ;
  - un fichier `links.json` optionnel dans l'album liste des médias externes (ex. vidéos YouTube, puisqu'un lien YouTube ne peut pas être "un fichier du dossier") ;
  - un fichier `meta.json` optionnel permet de personnaliser le nom affiché et la date de création (sinon la date de création du dossier sur le disque est utilisée).

  Pour ajouter un album "à la main" (FTP, explorateur de fichiers...), il suffit de créer un sous-dossier dans `src/storage/sary/` et d'y déposer des images/vidéos — l'API le détecte automatiquement, sans redémarrage.

## Endpoints

### Vaovao — `/api/vaovao`
| Méthode | Route | Description |
|---|---|---|
| GET | `/` | Liste publique (annonces non masquées) |
| GET | `/all` | Liste complète, admin (avec masquées) |
| GET | `/:id` | Une annonce |
| POST | `/` | Créer |
| PUT | `/:id` | Modifier |
| DELETE | `/:id` | Supprimer |
| PATCH | `/:id/masque` | Bascule masqué/visible |

### Évènements — `/api/evenements`
Mêmes routes que Vaovao (`/`, `/all`, `/:id`, POST, PUT, DELETE, `PATCH /:id/masque`).

### Sary — `/api/sary`
| Méthode | Route | Description |
|---|---|---|
| GET | `/` | Liste tous les albums (scan du disque) |
| GET | `/:id` | Un album |
| POST | `/` | Créer un album — body `{ "nom": "..." }` |
| PUT | `/:id` | Renommer un album — body `{ "nom": "..." }` |
| DELETE | `/:id` | Supprimer un album (et tout son contenu) |
| POST | `/:id/medias` | Ajouter un média : soit un fichier (`multipart/form-data`, champ `file`), soit un lien externe en JSON `{ "type": "youtube"\|"image"\|"mp4", "url": "...", "titre": "..." }` |
| DELETE | `/:id/medias/:mediaId` | Retirer un média (fichier ou lien) |

Les fichiers uploadés sont servis statiquement sous `/storage/sary/<album>/<fichier>`.

### Contact — `/api/contact`
| Méthode | Route | Description |
|---|---|---|
| POST | `/` | Envoie le message du formulaire de contact — body `{ "name": "...", "email": "...", "message": "..." }` |
| GET | `/` | Liste des messages reçus (admin) |

Chaque message est toujours enregistré dans `src/data/messages.json`. L'envoi du mail réel nécessite une config SMTP :
copier `.env.example` en `.env` et renseigner `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `MAIL_TO`. Sans `.env`, le message
est quand même reçu et enregistré, mais aucun mail n'est envoyé (un avertissement s'affiche dans les logs du serveur).

### Statistiques — `/api/stats`
| Méthode | Route | Description |
|---|---|---|
| POST | `/pageview` | Enregistre une navigation de page — body `{ "path": "...", "sessionId": "...", "referrer": "..." }` (appelé automatiquement par le front à chaque changement de route) |
| GET | `/summary` | Agrégats pour le tableau de bord : total pages vues, total sessions, pages les plus visitées, pays d'origine, vues/connexions par jour (14 derniers jours) |
| GET | `/visitors` | Détail des 100 dernières sessions : IP, localisation, première/dernière visite, liste des pages parcourues |

La localisation (pays/région/ville) est résolue à partir de l'IP via [ip-api.com](https://ip-api.com) (gratuit, sans clé),
en tâche de fond et mise en cache dans `src/data/ip-locations.json` (une IP n'est résolue qu'une fois). Les IP locales/privées
(127.0.0.1, 192.168.x, etc. — le cas en développement) sont marquées `"Local"` sans appel externe. Les pages vues sont
stockées dans `src/data/pageviews.json`.

⚠️ Ceci collecte des données de navigation (IP, localisation approximative, parcours) — à garder en tête pour la conformité
RGPD si le site reçoit des visiteurs européens (mentions légales / bandeau d'information selon votre politique de confidentialité).

## CORS

Ouvert à toutes les origines pour l'instant (développement). À restreindre en production dans `src/server.js`.
