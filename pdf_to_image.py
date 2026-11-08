import fitz
import os


def pdf_to_images(pdf_path, output_folder="converted_images"):

    # Create output folder
    os.makedirs(output_folder, exist_ok=True)

    # Open PDF
    pdf = fitz.open(pdf_path)

    print(f"Pages Found: {len(pdf)}")

    for page_num in range(len(pdf)):

        page = pdf[page_num]

        # Increase resolution
        matrix = fitz.Matrix(3, 3)

        pix = page.get_pixmap(matrix=matrix)

        image_path = os.path.join(
            output_folder,
            f"page_{page_num + 1}.png"
        )

        pix.save(image_path)

        print(
            f"✅ Saved: {image_path}"
        )

    pdf.close()

    print(
        "\n✅ PDF conversion completed."
    )


if __name__ == "__main__":

    pdf_file = "invoice_Aaron Bergman_36258.pdf"

    pdf_to_images(pdf_file)
