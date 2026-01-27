# Astro API (JS)

A Node.js-based Astrology API that utilizes the **Swiss Ephemeris** (via the `sweph` library) to calculate planetary positions, aspects, and Placidus house systems.

## Features

- **Planetary Positions**: Calculates positions for the Sun, Moon, major planets, asteroids (Ceres, Pallas, Juno, Vesta), Chiron, and Lunar Nodes.
- **Aspects**: Identifies major aspects (Conjunction, Opposition, Trine, Square, Sextile, Quincunx, Semi-Sextile) with customizable orbs.
- **House Systems**: Calculates Placidus houses and sensitive points (Ascendant, Midheaven, Vertex, etc.).
- **Timezone Support**: Handles local time to UTC conversion using `luxon`.
- **Security & Performance**: Includes CORS support, rate limiting, and structured logging with `winston`.

## Project Structure

- `APIserver.js`: The main Express.js server and astrology logic.
- `index.html`: A sample frontend client to demonstrate API interaction.
- `package.json`: Project metadata and dependencies.
- `ephe/`: Directory containing basic Swiss Ephemeris files (`.se1`).

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v14 or higher recommended)

### Installation

1. Clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```

### Running the Server

Start the API:
```bash
npm start
```
The server will be available at `http://localhost:3000`.

## Deployment

You can deploy this API directly to Render with a single click. Render will automatically detect the `render.yaml` configuration, install dependencies, and start the server.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

## API Documentation

### Endpoint: `GET /calculate`

Calculates astrological data for a specific time and location.

#### Query Parameters

| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `name` | String | Yes | Name for the chart. |
| `type` | String | Yes | `Person` or `Event`. |
| `gender` | String | If type=Person | `Male` or `Female`. |
| `year` | Integer | Yes | Year of birth/event (e.g., 1983). |
| `month` | Integer | Yes | Month (1-12). |
| `day` | Integer | Yes | Day (1-31). |
| `hour` | Integer | Yes | Hour in 24h format (0-23). |
| `minute` | Integer | Yes | Minute (0-59). |
| `second` | Number | Yes | Second (0-59.99). |
| `timezone` | String | Yes | IANA timezone (e.g., `Europe/Bucharest`). |
| `latitude` | Number | Yes | Decimal latitude (-90 to 90). |
| `longitude` | Number | Yes | Decimal longitude (-180 to 180). |

#### Example Call

```bash
http://localhost:3000/calculate?name=John&type=Person&gender=Male&year=1983&month=5&day=9&hour=10&minute=40&second=0&timezone=Europe/Bucharest&latitude=47.1667&longitude=27.6000
```

## Client Demonstration

You can test the API by opening `index.html` in your browser. It provides a simple form to input data and displays the raw JSON output from the API.

## License

Refer to the project's license for usage rights.
