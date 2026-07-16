// Command inspect-version reads the main.version Go string from an ELF or
// Mach-O provider binary without executing the target platform binary.
package main

import (
	"debug/elf"
	"debug/macho"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: go run provider/release/inspect-version.go <provider-binary>")
		os.Exit(2)
	}
	version, err := inspect(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println(version)
}

func inspect(path string) (string, error) {
	if f, err := elf.Open(path); err == nil {
		defer f.Close()
		return inspectELF(f)
	}
	if f, err := macho.Open(path); err == nil {
		defer f.Close()
		return inspectMachO(f)
	}
	return "", fmt.Errorf("%s is not a supported ELF or Mach-O provider binary", path)
}

func inspectELF(f *elf.File) (string, error) {
	symbols, err := f.Symbols()
	if err != nil {
		return "", fmt.Errorf("read ELF symbols: %w", err)
	}
	for _, symbol := range symbols {
		if symbol.Name == "main.version" {
			return readGoString(f.ByteOrder, f.Class == elf.ELFCLASS64, symbol.Value,
				func(address uint64, size uint64) ([]byte, error) {
					for _, section := range f.Sections {
						if address < section.Addr || address+size > section.Addr+section.Size {
							continue
						}
						return readAt(section, int64(address-section.Addr), size)
					}
					return nil, fmt.Errorf("ELF address %#x (size %d) is not mapped", address, size)
				})
		}
	}
	return "", errors.New("ELF symbol main.version not found")
}

func inspectMachO(f *macho.File) (string, error) {
	if f.Symtab == nil {
		return "", errors.New("Mach-O symbol table is absent")
	}
	for _, symbol := range f.Symtab.Syms {
		if strings.TrimPrefix(symbol.Name, "_") == "main.version" {
			return readGoString(f.ByteOrder, f.Magic == macho.Magic64, symbol.Value,
				func(address uint64, size uint64) ([]byte, error) {
					for _, section := range f.Sections {
						if address < section.Addr || address+size > section.Addr+section.Size {
							continue
						}
						return readAt(section, int64(address-section.Addr), size)
					}
					return nil, fmt.Errorf("Mach-O address %#x (size %d) is not mapped", address, size)
				})
		}
	}
	return "", errors.New("Mach-O symbol main.version not found")
}

func readGoString(order binary.ByteOrder, is64Bit bool, headerAddress uint64,
	readAddress func(uint64, uint64) ([]byte, error)) (string, error) {
	wordSize := uint64(4)
	if is64Bit {
		wordSize = 8
	}
	header, err := readAddress(headerAddress, wordSize*2)
	if err != nil {
		return "", fmt.Errorf("read main.version header: %w", err)
	}
	var dataAddress, length uint64
	if is64Bit {
		dataAddress = order.Uint64(header[0:8])
		length = order.Uint64(header[8:16])
	} else {
		dataAddress = uint64(order.Uint32(header[0:4]))
		length = uint64(order.Uint32(header[4:8]))
	}
	if length == 0 || length > 1024 {
		return "", fmt.Errorf("main.version has invalid length %d", length)
	}
	value, err := readAddress(dataAddress, length)
	if err != nil {
		return "", fmt.Errorf("read main.version value: %w", err)
	}
	return string(value), nil
}

func readAt(reader io.ReaderAt, offset int64, size uint64) ([]byte, error) {
	value := make([]byte, size)
	if _, err := reader.ReadAt(value, offset); err != nil {
		return nil, err
	}
	return value, nil
}
