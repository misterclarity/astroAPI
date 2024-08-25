// Load environment variables from a .env file
require("dotenv").config();

// Import required modules
const express = require("express");
const cors = require("cors");
const {
  utc_to_jd,
  calc,
  constants,
  set_ephe_path,
  houses_ex2,
} = require("sweph");
const rateLimit = require("express-rate-limit");
const winston = require("winston");
const { DateTime } = require("luxon");

// Initialize Express app
const app = express();

// Configure Express to trust the reverse proxy
app.set("trust proxy", true);

// Set up logging
const logger = winston.createLogger({
  level: "info",
  format: winston.format.json(),
  defaultMeta: { service: "astrology-api" },
  transports: [
    new winston.transports.File({ filename: "error.log", level: "error" }),
    new winston.transports.File({ filename: "combined.log" }),
  ],
});

if (process.env.NODE_ENV !== "production") {
  logger.add(
    new winston.transports.Console({
      format: winston.format.simple(),
    })
  );
}

const port = process.env.PORT || 3000;

app.use(cors());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  trustProxy: true,
  keyGenerator: (req) => {
    return (
      req.ip || req.headers["x-forwarded-for"] || req.connection.remoteAddress
    );
  },
});
app.use(limiter);

app.use((req, res, next) => {
  logger.info(`Incoming request: ${req.method} ${req.originalUrl}`, {
    ip: req.ip,
    forwardedFor: req.headers["x-forwarded-for"],
    realIp: req.connection.remoteAddress,
    headers: req.headers,
    query: req.query,
  });
  next();
});

set_ephe_path(process.env.EPHE_PATH || "/app/ephemeris");

app.get("/health", (req, res) => {
  res.send({ status: "Server is running" });
});

/**
 * Determines the zodiac sign based on the ecliptic longitude
 * @param {number} eclipticLongitude - The ecliptic longitude in degrees
 * @returns {string} The zodiac sign
 */
function getZodiacSign(eclipticLongitude) {
  const zodiacSigns = [
    "Aries",
    "Taurus",
    "Gemini",
    "Cancer",
    "Leo",
    "Virgo",
    "Libra",
    "Scorpio",
    "Sagittarius",
    "Capricorn",
    "Aquarius",
    "Pisces",
  ];
  const signIndex = Math.floor(eclipticLongitude / 30) % 12;
  return zodiacSigns[signIndex];
}

/**
 * Calculates the precise position within a zodiac sign
 * @param {number} eclipticLongitude - The ecliptic longitude in degrees
 * @returns {Object} Object containing degrees, minutes, and seconds
 */
function getPrecisePosition(eclipticLongitude) {
  const totalDegrees = eclipticLongitude % 30;
  const degrees = Math.floor(totalDegrees);
  const minutesFloat = (totalDegrees - degrees) * 60;
  const minutes = Math.floor(minutesFloat);
  const seconds = Math.round((minutesFloat - minutes) * 60);

  return { degrees, minutes, seconds };
}

/**
 * Calculates planetary positions for a given date and time
 * @param {number} year
 * @param {number} month
 * @param {number} day
 * @param {number} hour
 * @param {number} minute
 * @param {number} second
 * @param {string} timezone - The timezone of the input date and time
 * @param {number} latitude - The latitude for house calculations
 * @param {number} longitude - The longitude for house calculations
 * @returns {Object} Object containing positions, aspects, and houses
 */
function calculatePlanetPositions(
  year,
  month,
  day,
  hour,
  minute,
  second,
  timezone,
  latitude,
  longitude
) {
  try {
    // Convert local time to UTC
    const localTime = DateTime.fromObject(
      { year, month, day, hour, minute, second },
      { zone: timezone }
    );
    const utcTime = localTime.toUTC();

    // Convert UTC time to Julian Date
    const date = utc_to_jd(
      utcTime.year,
      utcTime.month,
      utcTime.day,
      utcTime.hour,
      utcTime.minute,
      utcTime.second,
      constants.SE_GREG_CAL
    );
    if (date.flag !== constants.OK) {
      throw new Error(`Error converting to Julian Date: ${date.error}`);
    }
    const [jd_et, jd_ut] = date.data;

    // Set calculation flags
    const flags = constants.SEFLG_SWIEPH | constants.SEFLG_SPEED;

    // Define planets and points to calculate
    const celestialBodies = [
      { name: "Sun", id: constants.SE_SUN },
      { name: "Moon", id: constants.SE_MOON },
      { name: "Mercury", id: constants.SE_MERCURY },
      { name: "Venus", id: constants.SE_VENUS },
      { name: "Mars", id: constants.SE_MARS },
      { name: "Jupiter", id: constants.SE_JUPITER },
      { name: "Saturn", id: constants.SE_SATURN },
      { name: "Uranus", id: constants.SE_URANUS },
      { name: "Neptune", id: constants.SE_NEPTUNE },
      { name: "Pluto", id: constants.SE_PLUTO },
      { name: "Chiron", id: constants.SE_CHIRON },
      { name: "Ceres", id: constants.SE_CERES },
      { name: "Pallas", id: constants.SE_PALLAS },
      { name: "Juno", id: constants.SE_JUNO },
      { name: "Vesta", id: constants.SE_VESTA },
      { name: "True North Node", id: constants.SE_TRUE_NODE },
      { name: "True South Node", id: constants.SE_TRUE_NODE },
      { name: "Mean North Node", id: constants.SE_MEAN_NODE },
      { name: "Mean South Node", id: constants.SE_MEAN_NODE },
    ];

    // Calculate positions for celestial bodies
    const positions = celestialBodies.map((body) => {
      const position = calc(jd_et, body.id, flags);
      if (position.flag !== flags) {
        throw new Error(`Error calculating ${body.name}: ${position.error}`);
      }
      let eclipticLongitude = position.data[0];

      // Special handling for South Nodes
      if (body.name === "True South Node" || body.name === "Mean South Node") {
        eclipticLongitude = (eclipticLongitude + 180) % 360;
      }

      const zodiacSign = getZodiacSign(eclipticLongitude);
      const precisePosition = getPrecisePosition(eclipticLongitude);
      const isRetrograde = position.data[3] < 0; // Check if speed in longitude is negative

      return {
        body: body.name,
        zodiacSign,
        position: precisePosition,
        isRetrograde: !body.name.includes("Node") ? isRetrograde : null,
        _eclipticLongitude: eclipticLongitude, // Keep for internal calculations
      };
    });

    // Calculate houses
    const houseData = calculateHouses(jd_ut, latitude, longitude);

    // Add Ascendant and Midheaven to positions
    positions.push({
      body: "Ascendant",
      zodiacSign: getZodiacSign(houseData.points.asc),
      position: getPrecisePosition(houseData.points.asc),
      _eclipticLongitude: houseData.points.asc, // Keep for internal calculations
    });

    positions.push({
      body: "Midheaven",
      zodiacSign: getZodiacSign(houseData.points.mc),
      position: getPrecisePosition(houseData.points.mc),
      _eclipticLongitude: houseData.points.mc, // Keep for internal calculations
    });

    // Calculate aspects
    const aspects = calculateAspects(positions);

    // Remove _eclipticLongitude before returning
    const positionsWithoutEclipticLongitude = positions.map(({ _eclipticLongitude, ...rest }) => rest);

    return {
      positions: positionsWithoutEclipticLongitude,
      aspects,
      houses: houseData.houses,
      points: houseData.points,
    };
  } catch (error) {
    console.error("Error in calculatePlanetPositions:", error);
    throw error;
  }
}

function calculateAspects(positions) {
  const aspects = [];
  const aspectDefinitions = [
    { name: "Conjunction", angle: 0, orb: 8 },
    { name: "Opposition", angle: 180, orb: 8 },
    { name: "Trine", angle: 120, orb: 8 },
    { name: "Square", angle: 90, orb: 7 },
    { name: "Sextile", angle: 60, orb: 6 },
    { name: "Quincunx", angle: 150, orb: 5 },
    { name: "Semi-Sextile", angle: 30, orb: 3 },
  ];

  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const body1 = positions[i];
      const body2 = positions[j];
      const angleDiff =
        (body2._eclipticLongitude - body1._eclipticLongitude + 360) % 360;
      const smallerAngle = Math.min(angleDiff, 360 - angleDiff);

      for (const aspectDef of aspectDefinitions) {
        const orb = Math.abs(smallerAngle - aspectDef.angle);
        if (orb <= aspectDef.orb) {
          const orbDegrees = Math.floor(orb);
          const orbMinutes = Math.round((orb - orbDegrees) * 60);

          const orbFormatted = `${orbDegrees}°${orbMinutes
            .toString()
            .padStart(2, "0")}'`;

          const aspect = {
            body1: body1.body,
            body2: body2.body,
            aspect: aspectDef.name,
            orb: orbFormatted,
          };

          aspects.push(aspect);
          break;
        }
      }
    }
  }

  return aspects;
}

/**
 * Calculates Placidus house positions
 * @param {number} jd_ut - Julian day in universal time
 * @param {number} latitude - Geographic latitude
 * @param {number} longitude - Geographic longitude
 * @returns {Object} Object containing house positions
 */
function calculateHouses(jd_ut, latitude, longitude) {
  const result = houses_ex2(jd_ut, 0, latitude, longitude, "P");
  if (result.flag !== constants.OK) {
    throw new Error("Error calculating houses: " + result.error);
  }

  const ordinalNames = [
    "1st", "2nd", "3rd", "4th", "5th", "6th",
    "7th", "8th", "9th", "10th", "11th", "12th"
  ];

  const housePositions = result.data.houses.map((position, index) => ({
    house: ordinalNames[index],
    formattedPosition: getPrecisePosition(position),
  }));

  const points = {
    asc: result.data.points[0],
    mc: result.data.points[1],
    armc: result.data.points[2],
    vertex: result.data.points[3],
    equasc: result.data.points[4],
    coasc1: result.data.points[5],
    coasc2: result.data.points[6],
    polasc: result.data.points[7],
  };

  return {
    houses: housePositions,
    points: points,
  };
}

/**
 * Middleware for input validation
 */
const validateCalculateInput = (req, res, next) => {
  const {
    year = 2000,
    month = 1,
    day = 1,
    hour = 0,
    minute = 0,
    second = 0,
    timezone,
    latitude,
    longitude,
    name,
    type,
    gender,
  } = req.query;

  // Convert query string parameters to appropriate types
  const parsedYear = parseInt(year);
  const parsedMonth = parseInt(month);
  const parsedDay = parseInt(day);
  const parsedHour = parseInt(hour);
  const parsedMinute = parseInt(minute);
  const parsedSecond = parseFloat(second);
  const parsedLatitude = parseFloat(latitude);
  const parsedLongitude = parseFloat(longitude);

  if (![parsedYear, parsedMonth, parsedDay, parsedHour, parsedMinute].every(Number.isInteger)) {
    return res
      .status(400)
      .json({ error: "All time parameters except 'second' must be integers" });
  }
  if (
    parsedMonth < 1 ||
    parsedMonth > 12 ||
    parsedDay < 1 ||
    parsedDay > 31 ||
    parsedHour < 0 ||
    parsedHour > 23 ||
    parsedMinute < 0 ||
    parsedMinute > 59 ||
    parsedSecond < 0 ||
    parsedSecond >= 60
  ) {
    return res.status(400).json({ error: "Invalid date or time values" });
  }
  if (!timezone || !DateTime.local().setZone(timezone).isValid) {
    return res.status(400).json({ error: "Invalid or missing timezone" });
  }
  if (isNaN(parsedLatitude) || parsedLatitude < -90 || parsedLatitude > 90) {
    return res.status(400).json({ error: "Invalid latitude" });
  }
  if (isNaN(parsedLongitude) || parsedLongitude < -180 || parsedLongitude > 180) {
    return res.status(400).json({ error: "Invalid longitude" });
  }
  if (!name || name.trim() === "") {
    return res.status(400).json({ error: "Name is required" });
  }
  if (!type || (type !== "Person" && type !== "Event")) {
    return res.status(400).json({ error: "Type must be either 'Person' or 'Event'" });
  }
  if (type === "Person" && (!gender || (gender !== "Male" && gender !== "Female"))) {
    return res.status(400).json({ error: "Gender must be either 'Male' or 'Female' for Person type" });
  }

  // Attach parsed values to the request object
  req.parsedQuery = {
    year: parsedYear,
    month: parsedMonth,
    day: parsedDay,
    hour: parsedHour,
    minute: parsedMinute,
    second: parsedSecond,
    timezone,
    latitude: parsedLatitude,
    longitude: parsedLongitude,
    name,
    type,
    gender,
  };

  next();
};

// Updated API endpoint for calculating planetary positions
app.get("/calculate", validateCalculateInput, (req, res) => {
  const {
    year,
    month,
    day,
    hour,
    minute,
    second,
    timezone,
    latitude,
    longitude,
    name,
    type,
    gender,
  } = req.parsedQuery;

  try {
    const result = calculatePlanetPositions(
      year,
      month,
      day,
      hour,
      minute,
      second,
      timezone,
      latitude,
      longitude
    );

    const response = {
      header: {
        generated: new Date().toISOString(),
        version: "1.0"
      },
      body: {
        data: [{
          name: name,
          type: type,
          gender: gender || "",
          chart: {
            planets: result.positions,
            aspects: result.aspects,
            houses: result.houses,
          }
        }]
      }
    };

    res.json(response);
  } catch (error) {
    logger.error("Error in /calculate:", error);
    res
      .status(500)
      .json({ error: "Internal server error", details: error.message });
  }
});

app.use((req, res) => {
  logger.warn(`404 - Not Found: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: "Not Found" });
});

app.listen(port, () => {
  logger.info(`Astrology API listening at http://localhost:${port}`);
  logger.info(`Trust Proxy setting: ${app.get("trust proxy")}`);
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught Exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled Rejection at:", promise, "reason:", reason);
});

module.exports = app;
