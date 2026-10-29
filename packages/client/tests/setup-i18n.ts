import { i18n } from "@lingui/core";
import { messages as en } from "../src/locales/en/messages";
import { messages as zhHans } from "../src/locales/zh-Hans/messages";
import { messages as zhHant } from "../src/locales/zh-Hant/messages";

i18n.load({ en, "zh-Hans": zhHans, "zh-Hant": zhHant });
i18n.activate("en");
