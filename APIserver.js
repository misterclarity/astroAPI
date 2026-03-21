// Load environment variables from a .env file
require("dotenv").config();

// Import required modules
const cluster = require("cluster");
const os = require("os");
const express = require("express");
const cors = require("cors");
const compression = require("compression");
const helmet = require("helmet");
const path = require("path");
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
const { LRUCache } = require("lru-cache");

// --- Cluster mode: fork one worker per CPU core ---
const numCPUs = os.cpus().length;

if (cluster.isPrimary) {
  console.log(`Primary process ${process.pid} starting ${numCPUs} workers...`);

  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on("exit", (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} exited (${signal || code}). Restarting...`);
    cluster.fork();
  });
} else {
  // --- Worker process: run the Express server ---

  const app = express();

  // Configure Express to trust the reverse proxy
  app.set("trust proxy", true);

  // Set up logging
  const isProduction = process.env.NODE_ENV === "production";
  const logger = winston.createLogger({
    level: isProduction ? "warn" : "info",
    format: winston.format.json(),
    defaultMeta: { service: "astrology-api", pid: process.pid },
    transports: [
      new winston.transports.File({ filename: "error.log", level: "error" }),
      new winston.transports.File({ filename: "combined.log" }),
    ],
  });

  if (!isProduction) {
    logger.add(
      new winston.transports.Console({
        format: winston.format.simple(),
      })
    );
  }

  const port = process.env.PORT || 3000;

  // --- Middleware stack ---
  app.use(helmet());
  app.use(compression());
  app.use(cors());

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      return req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    },
  });
  app.use(limiter);

  // Lightweight request logging (no full headers)
  app.use((req, res, next) => {
    logger.info(`${req.method} ${req.originalUrl}`, { ip: req.ip });
    next();
  });

  // --- Swiss Ephemeris setup ---
  set_ephe_path(process.env.EPHE_PATH || path.join(__dirname, "ephe"));

  // --- LRU Cache for calculation results ---
  const calculationCache = new LRUCache({
    max: 500,
    ttl: 60 * 60 * 1000, // 1 hour
  });

  // --- Static lookup tables (hoisted out of functions for performance) ---
  const ZODIAC_SIGNS = [
    "Aries", "Taurus", "Gemini", "Cancer",
    "Leo", "Virgo", "Libra", "Scorpio",
    "Sagittarius", "Capricorn", "Aquarius", "Pisces",
  ];

  const CELESTIAL_BODIES = [
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

  const ASPECT_DEFINITIONS = [
    { name: "Conjunction", angle: 0, orb: 8 },
    { name: "Opposition", angle: 180, orb: 8 },
    { name: "Trine", angle: 120, orb: 8 },
    { name: "Square", angle: 90, orb: 7 },
    { name: "Sextile", angle: 60, orb: 6 },
    { name: "Quincunx", angle: 150, orb: 5 },
    { name: "Semi-Sextile", angle: 30, orb: 3 },
  ];

  const ORDINAL_NAMES = [
    "1st", "2nd", "3rd", "4th", "5th", "6th",
    "7th", "8th", "9th", "10th", "11th", "12th",
  ];

  const CALC_FLAGS = constants.SEFLG_SWIEPH | constants.SEFLG_SPEED;

  // --- Routes ---

  app.get("/health", (req, res) => {
    res.send({ status: "Server is running", pid: process.pid });
  });

  /**
   * Determines the zodiac sign based on the ecliptic longitude
   * @param {number} eclipticLongitude - The ecliptic longitude in degrees
   * @returns {string} The zodiac sign
   */
  function getZodiacSign(eclipticLongitude) {
    const signIndex = Math.floor(eclipticLongitude / 30) % 12;
    return ZODIAC_SIGNS[signIndex];
  }

  /**
   * Calculates the precise position within a zodiac sign
   * @param {number} eclipticLongitude - The ecliptic longitude in degrees
   * @returns {Object} Object containing degrees, minutes, and seconds
   */
  function getPrecisePosition(eclipticLongitude) {
    const totalDegrees = eclipticLongitude % 30;
    let degrees = Math.floor(totalDegrees);
    const minutesFloat = (totalDegrees - degrees) * 60;
    let minutes = Math.floor(minutesFloat);
    let seconds = Math.round((minutesFloat - minutes) * 60);

    // Handle carry-over: 60" → +1', 60' → +1°
    if (seconds === 60) {
      seconds = 0;
      minutes += 1;
    }
    if (minutes === 60) {
      minutes = 0;
      degrees += 1;
    }

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
    year, month, day, hour, minute, second,
    timezone, latitude, longitude, houseSystem = "P"
  ) {
    try {
      // Split fractional seconds: Luxon requires integer seconds,
      // but Swiss Ephemeris utc_to_jd() needs the full float precision.
      const secInt = Math.floor(second);
      const secFrac = second - secInt;

      // Convert local time to UTC (using integer seconds for Luxon)
      const localTime = DateTime.fromObject(
        { year, month, day, hour, minute, second: secInt },
        { zone: timezone }
      );
      const utcTime = localTime.toUTC();

      // Recombine: integer second from Luxon + milliseconds + original fractional remainder
      const utcSecond = utcTime.second + (utcTime.millisecond / 1000) + secFrac;

      // Select calendar: Gregorian from Oct 15, 1582 onward; Julian before that
      const isGregorian = utcTime.year > 1582 ||
        (utcTime.year === 1582 && (utcTime.month > 10 || (utcTime.month === 10 && utcTime.day >= 15)));
      const calFlag = isGregorian ? constants.SE_GREG_CAL : constants.SE_JUL_CAL;

      // Convert UTC time to Julian Date
      const date = utc_to_jd(
        utcTime.year, utcTime.month, utcTime.day,
        utcTime.hour, utcTime.minute, utcSecond,
        calFlag
      );
      if (date.flag !== constants.OK) {
        throw new Error(`Error converting to Julian Date: ${date.error}`);
      }
      const [jd_et, jd_ut] = date.data;

      // Calculate positions for celestial bodies
      const positions = CELESTIAL_BODIES.map((body) => {
        const position = calc(jd_et, body.id, CALC_FLAGS);
        if ((position.flag & CALC_FLAGS) !== CALC_FLAGS) {
          throw new Error(`Error calculating ${body.name}: ${position.error}`);
        }
        let eclipticLongitude = position.data[0];

        // Special handling for South Nodes
        if (body.name === "True South Node" || body.name === "Mean South Node") {
          eclipticLongitude = (eclipticLongitude + 180) % 360;
        }

        return {
          body: body.name,
          zodiacSign: getZodiacSign(eclipticLongitude),
          position: getPrecisePosition(eclipticLongitude),
          isRetrograde: !body.name.includes("Node") ? position.data[3] < 0 : null,
          _eclipticLongitude: eclipticLongitude,
        };
      });

      // Calculate houses
      const houseData = calculateHouses(jd_ut, latitude, longitude, houseSystem);

      // Add Ascendant and Midheaven to positions
      positions.push({
        body: "Ascendant",
        zodiacSign: getZodiacSign(houseData.points.asc),
        position: getPrecisePosition(houseData.points.asc),
        _eclipticLongitude: houseData.points.asc,
      });

      positions.push({
        body: "Midheaven",
        zodiacSign: getZodiacSign(houseData.points.mc),
        position: getPrecisePosition(houseData.points.mc),
        _eclipticLongitude: houseData.points.mc,
      });

      // Calculate aspects
      const aspects = calculateAspects(positions);

      // Remove _eclipticLongitude before returning
      const positionsWithoutEclipticLongitude = positions.map(
        ({ _eclipticLongitude, ...rest }) => rest
      );

      return {
        positions: positionsWithoutEclipticLongitude,
        aspects,
        houses: houseData.houses,
        points: houseData.points,
      };
    } catch (error) {
      logger.error("Error in calculatePlanetPositions:", error);
      throw error;
    }
  }

  /**
   * Calculates aspects between planets.
   */
  function calculateAspects(positions) {
    const aspects = [];

    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const body1 = positions[i];
        const body2 = positions[j];
        const angleDiff =
          (body2._eclipticLongitude - body1._eclipticLongitude + 360) % 360;
        const smallerAngle = Math.min(angleDiff, 360 - angleDiff);

        for (const aspectDef of ASPECT_DEFINITIONS) {
          const orb = Math.abs(smallerAngle - aspectDef.angle);
          if (orb <= aspectDef.orb) {
            const orbDegrees = Math.floor(orb);
            const orbMinutes = Math.round((orb - orbDegrees) * 60);

            aspects.push({
              body1: body1.body,
              body2: body2.body,
              aspect: aspectDef.name,
              orb: `${orbDegrees}\u00B0${orbMinutes.toString().padStart(2, "0")}'`,
            });
            break;
          }
        }
      }
    }

    return aspects;
  }

  /**
   * Calculates house positions
   * @param {number} jd_ut - Julian day in universal time
   * @param {number} latitude - Geographic latitude
   * @param {number} longitude - Geographic longitude
   * @returns {Object} Object containing house positions
   */
  function calculateHouses(jd_ut, latitude, longitude, houseSystem = "P") {
    const result = houses_ex2(jd_ut, 0, latitude, longitude, houseSystem);
    if (result.flag !== constants.OK) {
      throw new Error("Error calculating houses: " + result.error);
    }

    const housePositions = result.data.houses.map((position, index) => ({
      house: ORDINAL_NAMES[index],
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

    return { houses: housePositions, points };
  }

  /**
   * Middleware for input validation
   */
  const validateCalculateInput = (req, res, next) => {
    const {
      year = 2000, month = 1, day = 1,
      hour = 0, minute = 0, second = 0,
      timezone, latitude, longitude,
      name, type, gender, houseSystem,
    } = req.query;

    const parsedYear = parseInt(year);
    const parsedMonth = parseInt(month);
    const parsedDay = parseInt(day);
    const parsedHour = parseInt(hour);
    const parsedMinute = parseInt(minute);
    const parsedSecond = parseFloat(second);
    const parsedLatitude = parseFloat(latitude);
    const parsedLongitude = parseFloat(longitude);

    if (![parsedYear, parsedMonth, parsedDay, parsedHour, parsedMinute].every(Number.isInteger)) {
      return res.status(400).json({ error: "All time parameters except 'second' must be integers" });
    }
    if (
      parsedMonth < 1 || parsedMonth > 12 ||
      parsedDay < 1 || parsedDay > 31 ||
      parsedHour < 0 || parsedHour > 23 ||
      parsedMinute < 0 || parsedMinute > 59 ||
      parsedSecond < 0 || parsedSecond >= 60
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

    req.parsedQuery = {
      year: parsedYear, month: parsedMonth, day: parsedDay,
      hour: parsedHour, minute: parsedMinute, second: parsedSecond,
      timezone, latitude: parsedLatitude, longitude: parsedLongitude,
      name, type, gender,
      houseSystem: houseSystem || "P",
    };

    next();
  };

  // API endpoint for calculating planetary positions
  app.get("/calculate", validateCalculateInput, (req, res) => {
    const {
      year, month, day, hour, minute, second,
      timezone, latitude, longitude,
      name, type, gender, houseSystem,
    } = req.parsedQuery;

    try {
      // Build cache key from calculation-relevant params only (not name/type/gender)
      const cacheKey = `${year}:${month}:${day}:${hour}:${minute}:${second}:${timezone}:${latitude}:${longitude}:${houseSystem}`;

      let result = calculationCache.get(cacheKey);
      if (!result) {
        result = calculatePlanetPositions(
          year, month, day, hour, minute, second,
          timezone, latitude, longitude, houseSystem
        );
        calculationCache.set(cacheKey, result);
      }

      const response = {
        header: {
          generated: new Date().toISOString(),
          version: "1.0",
        },
        body: {
          data: [{
            name,
            type,
            gender: gender || "",
            chart: {
              planets: result.positions,
              aspects: result.aspects,
              houses: result.houses,
            },
          }],
        },
      };

      res.json(response);
    } catch (error) {
      logger.error("Error in /calculate:", error);
      res.status(500).json({ error: "Internal server error", details: error.message });
    }
  });

  app.use((req, res) => {
    logger.warn(`404 - Not Found: ${req.method} ${req.originalUrl}`);
    res.status(404).json({ error: "Not Found" });
  });

  app.listen(port, () => {
    logger.info(`Worker ${process.pid} listening on port ${port}`);
  });

  process.on("uncaughtException", (error) => {
    logger.error("Uncaught Exception:", error);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason, promise) => {
    logger.error("Unhandled Rejection at:", promise, "reason:", reason);
  });

  module.exports = app;
}
