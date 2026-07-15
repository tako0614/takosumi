package provider

import (
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

var runtimeClassNamePattern = regexp.MustCompile(`^[A-Za-z_$][A-Za-z0-9_$]*$`)
var artifactSHA256Pattern = regexp.MustCompile(`^(sha256:)?[A-Fa-f0-9]{64}$`)

func validRuntimeClassName(value string) bool {
	return runtimeClassNamePattern.MatchString(value)
}

func printableBoundedString(value string, max int) bool {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || len(value) > max {
		return false
	}
	return !strings.ContainsFunc(value, func(r rune) bool {
		return unicode.IsControl(r)
	})
}

func normalizedPortableCron(value string) (string, bool) {
	fields := strings.Fields(value)
	if len(fields) != 5 {
		return "", false
	}
	ranges := [][2]int{{0, 59}, {0, 23}, {1, 31}, {1, 12}, {0, 7}}
	for index, field := range fields {
		if !validPortableCronField(field, ranges[index][0], ranges[index][1]) {
			return "", false
		}
	}
	return strings.Join(fields, " "), true
}

func validPortableCronField(field string, min, max int) bool {
	if field == "" || strings.ContainsFunc(field, func(r rune) bool {
		return !((r >= '0' && r <= '9') || strings.ContainsRune("*,-/", r))
	}) {
		return false
	}
	for _, item := range strings.Split(field, ",") {
		stepParts := strings.Split(item, "/")
		if len(stepParts) > 2 || stepParts[0] == "" {
			return false
		}
		if len(stepParts) == 2 {
			step, err := strconv.Atoi(stepParts[1])
			if err != nil || step < 1 {
				return false
			}
		}
		if stepParts[0] == "*" {
			continue
		}
		rangeParts := strings.Split(stepParts[0], "-")
		if len(rangeParts) > 2 {
			return false
		}
		start, err := strconv.Atoi(rangeParts[0])
		if err != nil {
			return false
		}
		end := start
		if len(rangeParts) == 2 {
			end, err = strconv.Atoi(rangeParts[1])
			if err != nil {
				return false
			}
		}
		if start < min || end > max || start > end {
			return false
		}
	}
	return true
}

func stringSliceContains(values any, wanted string) bool {
	switch items := values.(type) {
	case []string:
		for _, item := range items {
			if item == wanted {
				return true
			}
		}
	case []any:
		for _, item := range items {
			if item == wanted {
				return true
			}
		}
	}
	return false
}
