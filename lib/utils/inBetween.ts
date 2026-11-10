import { XSD } from "@treecg/types";
import { getLoggerFor } from "./logUtil";

const logger = getLoggerFor("InBetweenRelation");
export type Between = {
    min: Date;
    max: Date;
};

export function parseInBetweenRelation(value: string, dataType: string | undefined, defaultTimezone: string): Between | undefined {
    if (dataType === XSD.custom("gYear")) {
        const result = gYearToMinMax(value, defaultTimezone);
        if (!result) return;
        const [min, max] = result;
        return { min, max };
    } else if (dataType === XSD.custom("gYearMonth")) {
        const result = gYearMonthToMinMax(value, defaultTimezone);
        if (!result) return;
        const [min, max] = result;
        return { min, max };
    } else if (dataType === XSD.custom("date")) {
        const result = dateToMinMax(value, defaultTimezone);
        if (!result) return;
        const [min, max] = result;
        return { min, max };
    } else {
        // Check if it is a partial dateTime
        const result = partialDateTimeToMinMax(value, defaultTimezone);
        if (!result) return;
        const [min, max] = result;
        return { min, max };
    }
}

function gYearToMinMax(value: string, defaultTimezone: string): [Date, Date] | undefined {
    const regex = /^(-?[1-9][0-9]{3,}|-?0[0-9]{3})(Z|(\+|-)((0[0-9]|1[0-3]):([0-5][0-9])|14:00))?$/;
    const match = value.match(regex);
    if (!match) {
        logger.warn(`Invalid gYear format: ${value}`);
        return;
    }
    const year = parseInt(match[1]);
    let minOffset = 0;
    let maxOffset = 0;
    const timezone = match[2] || defaultTimezone;
    if (timezone === "AoE") {
        // Anywhere on Earth approach.
        minOffset = -12 * 60;
        maxOffset = 12 * 60;
    } else if (timezone !== "Z") {
        const sign = match[3];
        const h = parseInt(match[5]);
        const m = parseInt(match[6]);
        const offset = (sign === "+" ? 1 : -1) * (h * 60 + m);
        minOffset = offset;
        maxOffset = offset;
    }
    return [new Date(Date.UTC(year, 0, 1) + minOffset * 60 * 1000), new Date(Date.UTC(year + 1, 0, 1) + maxOffset * 60 * 1000)];
}

function gYearMonthToMinMax(value: string, defaultTimezone: string): [Date, Date] | undefined {
    const regex = /^(-?[1-9][0-9]{3,}|-?0[0-9]{3})-(0[1-9]|1[0-2])(Z|(\+|-)((0[0-9]|1[0-3]):([0-5][0-9])|14:00))?$/;
    const match = value.match(regex);
    if (!match) {
        logger.warn(`Invalid gYearMonth format: ${value}`);
        return;
    }
    const y = parseInt(match[1]);
    const m = parseInt(match[2]);
    let minOffset = 0;
    let maxOffset = 0;
    const timezone = match[3] || defaultTimezone;
    if (timezone === "AoE") {
        // Anywhere on Earth approach.
        minOffset = -12 * 60;
        maxOffset = 12 * 60;
    } else if (timezone !== "Z") {
        const sign = match[4];
        const h = parseInt(match[6]);
        const min = parseInt(match[7]);
        const offset = (sign === "+" ? 1 : -1) * (h * 60 + min);
        minOffset = offset;
        maxOffset = offset;
    }
    return [new Date(Date.UTC(y, m - 1, 1) + minOffset * 60 * 1000), new Date(Date.UTC(y, m, 1) + maxOffset * 60 * 1000)];
}

function dateToMinMax(value: string, defaultTimezone: string): [Date, Date] | undefined {
    const regex = /^(-?[1-9][0-9]{3,}|-?0[0-9]{3})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])(Z|(\+|-)((0[0-9]|1[0-3]):([0-5][0-9])|14:00))?$/;
    const match = value.match(regex);
    if (!match) {
        logger.warn(`Invalid date format: ${value}`);
        return;
    }
    const y = parseInt(match[1]);
    const m = parseInt(match[2]);
    const d = parseInt(match[3]);
    let minOffset = 0;
    let maxOffset = 0;
    const timezone = match[4] || defaultTimezone;
    if (timezone === "AoE") {
        // Anywhere on Earth approach.
        minOffset = -12 * 60;
        maxOffset = 12 * 60;
    } else if (timezone !== "Z") {
        const sign = match[5];
        const h = parseInt(match[7]);
        const min = parseInt(match[8]);
        const offset = (sign === "+" ? 1 : -1) * (h * 60 + min);
        minOffset = offset;
        maxOffset = offset;
    }
    return [new Date(Date.UTC(y, m - 1, d) + minOffset * 60 * 1000), new Date(Date.UTC(y, m - 1, d + 1) + maxOffset * 60 * 1000)];
}

function partialDateTimeToMinMax(value: string, defaultTimezone: string): [Date, Date] | undefined {
    const dateHourMinSecRegex =
        /^(-?[1-9][0-9]{3,}|-?0[0-9]{3})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])(Z|(\+|-)((0[0-9]|1[0-3]):([0-5][0-9])|14:00))?$/;
    const matchDHMS = value.match(dateHourMinSecRegex);
    if (matchDHMS) {
        const y = parseInt(matchDHMS[1]);
        const m = parseInt(matchDHMS[2]);
        const d = parseInt(matchDHMS[3]);
        const h = parseInt(matchDHMS[4]);
        const min = parseInt(matchDHMS[5]);
        const s = parseInt(matchDHMS[6]);
        let minOffset = 0;
        let maxOffset = 0;
        const timezone = matchDHMS[7] || defaultTimezone;
        if (timezone === "AoE") {
            // Anywhere on Earth approach.
            minOffset = -12 * 60;
            maxOffset = 12 * 60;
        } else if (timezone !== "Z") {
            const sign = matchDHMS[8];
            const hOff = parseInt(matchDHMS[10]);
            const minOff = parseInt(matchDHMS[11]);
            const offset = (sign === "+" ? 1 : -1) * (hOff * 60 + minOff);
            minOffset = offset;
            maxOffset = offset;
        }
        return [
            new Date(Date.UTC(y, m - 1, d, h, min, s) + minOffset * 60 * 1000),
            new Date(Date.UTC(y, m - 1, d, h, min, s + 1) + maxOffset * 60 * 1000),
        ];
    }
    const dateHourMinRegex =
        /^(-?[1-9][0-9]{3,}|-?0[0-9]{3})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):([0-5][0-9])(Z|(\+|-)((0[0-9]|1[0-3]):([0-5][0-9])|14:00))?$/;
    const matchDHM = value.match(dateHourMinRegex);
    if (matchDHM) {
        const y = parseInt(matchDHM[1]);
        const m = parseInt(matchDHM[2]);
        const d = parseInt(matchDHM[3]);
        const h = parseInt(matchDHM[4]);
        const min = parseInt(matchDHM[5]);
        let minOffset = 0;
        let maxOffset = 0;
        const timezone = matchDHM[6] || defaultTimezone;
        if (timezone === "AoE") {
            // Anywhere on Earth approach.
            minOffset = -12 * 60;
            maxOffset = 12 * 60;
        } else if (timezone !== "Z") {
            const sign = matchDHM[7];
            const hOff = parseInt(matchDHM[9]);
            const minOff = parseInt(matchDHM[10]);
            const offset = (sign === "+" ? 1 : -1) * (hOff * 60 + minOff);
            minOffset = offset;
            maxOffset = offset;
        }
        return [new Date(Date.UTC(y, m - 1, d, h, min) + minOffset * 60 * 1000), new Date(Date.UTC(y, m - 1, d, h, min + 1) + maxOffset * 60 * 1000)];
    }
    const dateHourRegex =
        /^(-?[1-9][0-9]{3,}|-?0[0-9]{3})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3])(Z|(\+|-)((0[0-9]|1[0-3]):([0-5][0-9])|14:00))?$/;
    const matchDH = value.match(dateHourRegex);
    if (matchDH) {
        const y = parseInt(matchDH[1]);
        const m = parseInt(matchDH[2]);
        const d = parseInt(matchDH[3]);
        const h = parseInt(matchDH[4]);
        let minOffset = 0;
        let maxOffset = 0;
        const timezone = matchDH[5] || defaultTimezone;
        if (timezone === "AoE") {
            // Anywhere on Earth approach.
            minOffset = -12 * 60;
            maxOffset = 12 * 60;
        } else if (timezone !== "Z") {
            const sign = matchDH[6];
            const hOff = parseInt(matchDH[8]);
            const minOff = parseInt(matchDH[9]);
            const offset = (sign === "+" ? 1 : -1) * (hOff * 60 + minOff);
            minOffset = offset;
            maxOffset = offset;
        }
        return [new Date(Date.UTC(y, m - 1, d, h) + minOffset * 60 * 1000), new Date(Date.UTC(y, m - 1, d, h + 1) + maxOffset * 60 * 1000)];
    }
}
