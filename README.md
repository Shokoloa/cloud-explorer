# Cloud Explorer

Un petit cloud personnel auto-hébergé : un explorateur de fichiers dans le navigateur, propulsé par Express. Les fichiers sont stockés sur le disque du serveur, sans base de données (les métadonnées sont dans un simple fichier JSON).

## Fonctionnalités

- Connexion par mot de passe unique
- Upload de fichiers (avec file d'attente et progression)
- Création de dossiers, renommage, déplacement, copie
- Téléchargement d'un fichier, ou d'une sélection / d'un dossier en `.zip`
- Aperçu des fichiers et éditeur de texte intégré
- Favoris, fichiers récents, arborescence
- Corbeille avec suppression automatique après un délai
- Liens de partage temporaires
- Quota de stockage

## Prérequis

- [Node.js](https://nodejs.org/) 18 ou plus récent

## Installation

```bash
git clone https://github.com/Shokoloa/cloud-explorer.git
cd cloud-explorer
npm install
cp .env.example .env
```

Ouvre ensuite `.env` et change au minimum `ADMIN_PASSWORD`.

## Lancer

```bash
npm start      # production
npm run dev    # rechargement automatique
```

Le site est accessible sur `http://localhost:3000` (selon `PORT`).

## Configuration

Tout se règle dans le fichier `.env` :

| Variable | Description | Défaut |
| --- | --- | --- |
| `PORT` | Port du serveur | `3000` |
| `HOST` | Adresse d'écoute | `0.0.0.0` |
| `ADMIN_PASSWORD` | Mot de passe de connexion | `change-me` |
| `STORAGE_PATH` | Dossier où sont stockés les fichiers | `./storage` |
| `DATA_PATH` | Fichier JSON des métadonnées | `./data/files.json` |
| `STORAGE_QUOTA` | Espace maximum, en octets | 20 Go |
| `MAX_UPLOAD_SIZE` | Taille maximum par fichier, en octets | 5 Go |
| `SESSION_TTL` | Durée de la session, en ms | 7 jours |
| `SHARE_TTL` | Durée par défaut d'un lien de partage, en ms | 7 jours |
| `TRASH_TTL` | Durée avant vidage automatique de la corbeille, en ms (`0` = jamais) | 30 jours |
| `TRUST_PROXY` | À mettre à `true` derrière un reverse proxy (Nginx, Caddy…) | `false` |

## Structure

```
server/
  index.js    routes de l'API
  auth.js     connexion et sessions
  db.js       lecture/écriture du fichier JSON
  storage.js  gestion des fichiers sur le disque
public/
  index.html  interface (front)
```

## Sécurité

- Change `ADMIN_PASSWORD` avant d'exposer le service : le serveur affiche un avertissement tant que la valeur par défaut est utilisée.
- Si tu l'exposes sur Internet, place-le derrière HTTPS (reverse proxy) et active `TRUST_PROXY=true`.
- Ne versionne jamais ton fichier `.env`, ni les dossiers `storage/` et `data/`.
